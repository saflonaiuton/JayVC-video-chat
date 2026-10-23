import { Router, type IRouter } from "express";
import {
  CreateGuestProfileResponse,
  GetJayvcConfigResponse,
  GetMatchmakingStatusResponse,
  JoinMatchmakingQueueBody,
  JoinMatchmakingQueueResponse,
  LeaveMatchmakingQueueResponse,
  SubmitGuestReportBody,
  SubmitGuestReportResponse,
} from "@workspace/api-zod";
import {
  allowRateLimit,
  ensureGuestProfile,
  getAdminClient,
  getPublicSupabaseConfig,
  provisionDailyRoom,
  readActiveMatch,
  verifyGuest,
  verifyTurnstile,
  type MatchStatusData,
} from "../lib/jayvc";

const router: IRouter = Router();

function parseStatus(data: MatchStatusData) {
  return GetMatchmakingStatusResponse.parse(data);
}

function unavailableStatus(message: string): MatchStatusData {
  return {
    state: "unavailable",
    displayName: null,
    roomUrl: null,
    meetingToken: null,
    matchId: null,
    message,
  };
}

async function profileName(admin: NonNullable<ReturnType<typeof getAdminClient>>, userId: string) {
  const { data, error } = await admin
    .from("guest_profiles")
    .select("display_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.display_name ?? null;
}

async function currentMatchStatus(
  admin: NonNullable<ReturnType<typeof getAdminClient>>,
  userId: string,
): Promise<MatchStatusData> {
  const activeMatch = await readActiveMatch(admin, userId);
  if (activeMatch) {
    const room = await provisionDailyRoom(admin, activeMatch, userId);
    if (!room) {
      return {
        state: "waiting",
        displayName: null,
        roomUrl: null,
        meetingToken: null,
        matchId: activeMatch.id,
        message: "Your match is ready. Preparing a private room…",
      };
    }

    const partnerId =
      activeMatch.user_a_id === userId
        ? activeMatch.user_b_id
        : activeMatch.user_a_id;
    const partnerName = await profileName(admin, partnerId);
    return {
      state: "matched",
      displayName: partnerName ?? "Guest",
      roomUrl: room.roomUrl,
      meetingToken: room.meetingToken,
      matchId: activeMatch.id,
      message: null,
    };
  }

  const { data: queue, error: queueError } = await admin
    .from("matchmaking_queue")
    .select("state,match_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (queueError) throw queueError;

  if (queue?.state === "waiting") {
    return {
      state: "waiting",
      displayName: null,
      roomUrl: null,
      meetingToken: null,
      matchId: null,
      message: "Looking for a compatible guest. Your preferences will not be changed.",
    };
  }

  if (queue?.match_id) {
    const { data: priorMatch, error: priorError } = await admin
      .from("matches")
      .select("state,ended_by")
      .eq("id", queue.match_id)
      .maybeSingle();
    if (priorError) throw priorError;
    if (
      priorMatch?.state === "ended" &&
      priorMatch.ended_by &&
      priorMatch.ended_by !== userId
    ) {
      return {
        state: "disconnected",
        displayName: null,
        roomUrl: null,
        meetingToken: null,
        matchId: queue.match_id,
        message: "The other guest left the conversation.",
      };
    }
  }

  return {
    state: "idle",
    displayName: null,
    roomUrl: null,
    meetingToken: null,
    matchId: null,
    message: null,
  };
}

router.get("/jayvc/config", async (_req, res): Promise<void> => {
  const config = getPublicSupabaseConfig();
  const admin = getAdminClient();
  let schemaReady = false;

  if (admin && config.supabaseConfigReady) {
    const [profiles, queue] = await Promise.all([
      admin.from("guest_profiles").select("user_id").limit(0),
      admin.from("matchmaking_queue").select("user_id").limit(0),
    ]);
    schemaReady = !profiles.error && !queue.error;
  }

  const supabaseReady = Boolean(config.supabaseConfigReady && schemaReady);
  const dailyReady = Boolean(process.env.DAILY_API_KEY);
  const turnstileReady = Boolean(
    process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY,
  );
  const data = GetJayvcConfigResponse.parse({
    mode: supabaseReady && dailyReady && turnstileReady ? "live" : "demo",
    supabaseReady,
    dailyReady,
    turnstileReady,
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
    turnstileSiteKey: config.turnstileSiteKey,
  });
  res.json(data);
});

router.post("/jayvc/profile", async (req, res): Promise<void> => {
  const address = req.ip || "unknown";
  if (!allowRateLimit(`profile:${address}`, 20)) {
    res.status(429).json({ error: "Please wait before trying again." });
    return;
  }

  const identity = await verifyGuest(req);
  if (!identity) {
    res.status(401).json({ error: "A valid guest session is required." });
    return;
  }
  if (!allowRateLimit(`profile-user:${identity.user.id}`, 10)) {
    res.status(429).json({ error: "Please wait before trying again." });
    return;
  }

  try {
    const profile = await ensureGuestProfile(identity.admin, identity.user.id);
    if (!profile) {
      res.status(503).json({ error: "A guest profile could not be created. Please retry." });
      return;
    }
    res.json(CreateGuestProfileResponse.parse(profile));
  } catch (error) {
    req.log.error({ err: error }, "JayVC guest profile operation failed");
    res.status(503).json({ error: "Guest profiles are unavailable. Apply the Supabase schema and retry." });
  }
});

router.post("/jayvc/queue", async (req, res): Promise<void> => {
  const address = req.ip || "unknown";
  if (!allowRateLimit(`queue:${address}`, 8)) {
    res.status(429).json({ error: "Please wait before trying again." });
    return;
  }

  const identity = await verifyGuest(req);
  if (!identity) {
    res.status(401).json({ error: "A valid guest session is required." });
    return;
  }
  if (!allowRateLimit(`queue-user:${identity.user.id}`, 5)) {
    res.status(429).json({ error: "Please wait before trying again." });
    return;
  }

  const parsed = JoinMatchmakingQueueBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose one of the available gender preferences." });
    return;
  }

  const captchaValid = await verifyTurnstile(
    parsed.data.turnstileToken,
    address === "unknown" ? undefined : address,
  );
  if (!captchaValid) {
    res.status(400).json({ error: "Complete the security check before joining the queue." });
    return;
  }

  try {
    const { admin, user } = identity;
    const profile = await ensureGuestProfile(admin, user.id);
    if (!profile) {
      res.status(503).json({ error: "A guest profile could not be created. Please retry." });
      return;
    }

    const { error: preferenceError } = await admin
      .from("guest_profiles")
      .update({
        gender: parsed.data.gender,
        match_with: parsed.data.matchWith,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id);
    if (preferenceError) throw preferenceError;

    const { error: queueError } = await admin.from("matchmaking_queue").upsert(
      {
        user_id: user.id,
        gender: parsed.data.gender,
        match_with: parsed.data.matchWith,
        state: "waiting",
        match_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (queueError) throw queueError;

    const { error: matchError } = await admin.rpc("match_guest_queue", {
      p_user_id: user.id,
    });
    if (matchError) throw matchError;

    res.json(JoinMatchmakingQueueResponse.parse(await currentMatchStatus(admin, user.id)));
  } catch (error) {
    req.log.error({ err: error }, "JayVC matchmaking operation failed");
    res.status(503).json(unavailableStatus("Matchmaking is not ready. Check the Supabase schema and retry."));
  }
});

router.get("/jayvc/queue", async (req, res): Promise<void> => {
  const identity = await verifyGuest(req);
  if (!identity) {
    res.status(401).json({ error: "A valid guest session is required." });
    return;
  }
  if (!allowRateLimit(`status:${identity.user.id}`, 90)) {
    res.status(429).json({ error: "Please wait before checking again." });
    return;
  }

  try {
    res.json(
      GetMatchmakingStatusResponse.parse(
        await currentMatchStatus(identity.admin, identity.user.id),
      ),
    );
  } catch (error) {
    req.log.error({ err: error }, "JayVC matchmaking status operation failed");
    res.status(503).json(unavailableStatus("Matchmaking status is unavailable. Please retry."));
  }
});

router.delete("/jayvc/queue", async (req, res): Promise<void> => {
  const identity = await verifyGuest(req);
  if (!identity) {
    res.status(401).json({ error: "A valid guest session is required." });
    return;
  }

  try {
    const { error } = await identity.admin.rpc("end_guest_match", {
      p_user_id: identity.user.id,
    });
    if (error) throw error;
    res.json(LeaveMatchmakingQueueResponse.parse({ success: true }));
  } catch (error) {
    req.log.error({ err: error }, "JayVC call-ending operation failed");
    res.status(503).json({ error: "The call could not be ended on the server. Please retry." });
  }
});

router.post("/jayvc/reports", async (req, res): Promise<void> => {
  const identity = await verifyGuest(req);
  if (!identity) {
    res.status(401).json({ error: "A valid guest session is required." });
    return;
  }

  const parsed = SubmitGuestReportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose a report reason and keep details under 500 characters." });
    return;
  }

  try {
    const match = await readActiveMatch(identity.admin, identity.user.id);
    if (!match) {
      res.status(400).json({ error: "There is no active match to report." });
      return;
    }
    const reportedId =
      match.user_a_id === identity.user.id ? match.user_b_id : match.user_a_id;
    const { error } = await identity.admin.from("guest_reports").insert({
      reporter_id: identity.user.id,
      reported_id: reportedId,
      match_id: match.id,
      reason: parsed.data.reason,
      details: parsed.data.details?.trim() || null,
    });
    if (error?.code === "23505") {
      res.status(409).json({ error: "A report for this conversation was already submitted." });
      return;
    }
    if (error) throw error;
    res.status(201).json(SubmitGuestReportResponse.parse({ submitted: true }));
  } catch (error) {
    req.log.error({ err: error }, "JayVC report submission failed");
    res.status(503).json({ error: "The report could not be submitted. Please retry." });
  }
});

export default router;
