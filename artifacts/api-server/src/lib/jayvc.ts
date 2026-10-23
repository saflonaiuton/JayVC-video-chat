import { randomInt } from "node:crypto";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { Request } from "express";

type AdminClient = SupabaseClient;

export type GuestIdentity = {
  user: User;
  admin: AdminClient;
};

export type MatchRecord = {
  id: string;
  user_a_id: string;
  user_b_id: string;
  state: "active" | "ended";
  ended_by: string | null;
  daily_room_name: string;
  daily_room_url: string | null;
  room_state: "pending" | "creating" | "ready" | "failed";
  room_claimed_at: string | null;
};

export type MatchStatusData = {
  state: "idle" | "waiting" | "matched" | "disconnected" | "unavailable";
  displayName: string | null;
  roomUrl: string | null;
  meetingToken: string | null;
  matchId: string | null;
  message: string | null;
};

const rateWindowMs = 60_000;
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

export function getAdminClient(): AdminClient | null {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

export function getPublicSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL ?? null;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? null;
  const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY ?? null;
  const supabaseConfigReady = Boolean(
    supabaseUrl && supabaseAnonKey && process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  return {
    supabaseUrl,
    supabaseAnonKey,
    turnstileSiteKey,
    supabaseConfigReady,
  };
}

export async function verifyGuest(request: Request): Promise<GuestIdentity | null> {
  const authorization = request.get("authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const admin = getAdminClient();
  if (!token || !admin) return null;

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return { user: data.user, admin };
}

export function allowRateLimit(key: string, maximum: number): boolean {
  const now = Date.now();
  const existing = rateLimitBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + rateWindowMs });
    if (rateLimitBuckets.size > 20_000) {
      for (const [bucketKey, bucket] of rateLimitBuckets) {
        if (bucket.resetAt <= now) rateLimitBuckets.delete(bucketKey);
      }
    }
    return true;
  }

  existing.count += 1;
  return existing.count <= maximum;
}

export async function verifyTurnstile(
  token: string | undefined,
  remoteIp: string | undefined,
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret || !token) return false;

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(8_000),
    },
  );
  if (!response.ok) return false;
  const result: unknown = await response.json();
  return (
    typeof result === "object" &&
    result !== null &&
    "success" in result &&
    (result as { success?: unknown }).success === true
  );
}

export async function ensureGuestProfile(
  admin: AdminClient,
  userId: string,
): Promise<{ displayName: string } | null> {
  const { data: existing, error: readError } = await admin
    .from("guest_profiles")
    .select("display_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (readError) throw readError;
  if (existing?.display_name) return { displayName: existing.display_name };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const displayName = `Guest ${randomInt(1000, 10_000)}`;
    const { data, error } = await admin
      .from("guest_profiles")
      .insert({ user_id: userId, display_name: displayName })
      .select("display_name")
      .single();
    if (!error && data) return { displayName: data.display_name };
    if (error?.code !== "23505") throw error;
  }
  return null;
}

export async function readActiveMatch(
  admin: AdminClient,
  userId: string,
): Promise<MatchRecord | null> {
  const { data, error } = await admin
    .from("matches")
    .select(
      "id,user_a_id,user_b_id,state,ended_by,daily_room_name,daily_room_url,room_state,room_claimed_at",
    )
    .eq("state", "active")
    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as MatchRecord | null) ?? null;
}

async function createDailyRoom(roomName: string): Promise<string> {
  const apiKey = process.env.DAILY_API_KEY;
  if (!apiKey) throw new Error("Daily is not configured.");
  const response = await fetch("https://api.daily.co/v1/rooms", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: roomName,
      privacy: "private",
      properties: {
        exp: Math.floor(Date.now() / 1000) + 60 * 60,
        max_participants: 2,
        enable_chat: false,
        enable_knocking: false,
        enable_screenshare: false,
      },
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`Daily room creation failed with status ${response.status}.`);
  }
  const result: unknown = await response.json();
  if (
    typeof result !== "object" ||
    result === null ||
    !("url" in result) ||
    typeof (result as { url?: unknown }).url !== "string"
  ) {
    throw new Error("Daily returned an invalid room response.");
  }
  return (result as { url: string }).url;
}

async function createDailyMeetingToken(
  roomName: string,
  displayName: string,
): Promise<string> {
  const apiKey = process.env.DAILY_API_KEY;
  if (!apiKey) throw new Error("Daily is not configured.");

  const response = await fetch("https://api.daily.co/v1/meeting-tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        room_name: roomName,
        user_name: displayName,
        exp: Math.floor(Date.now() / 1000) + 15 * 60,
        eject_at_room_exp: true,
        enable_screenshare: false,
      },
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`Daily token creation failed with status ${response.status}.`);
  }
  const result: unknown = await response.json();
  if (
    typeof result !== "object" ||
    result === null ||
    !("token" in result) ||
    typeof (result as { token?: unknown }).token !== "string"
  ) {
    throw new Error("Daily returned an invalid meeting-token response.");
  }
  return (result as { token: string }).token;
}

export async function provisionDailyRoom(
  admin: AdminClient,
  match: MatchRecord,
  userId: string,
): Promise<{ roomUrl: string; meetingToken: string } | null> {
  let roomUrl = match.daily_room_url;
  if (!roomUrl) {
    const { data, error } = await admin.rpc("claim_daily_room", {
      p_match_id: match.id,
      p_user_id: userId,
    });
    if (error) throw error;

    const claim = Array.isArray(data) ? data[0] : data;
    if (
      typeof claim !== "object" ||
      claim === null ||
      !("daily_room_name" in claim) ||
      typeof (claim as { daily_room_name?: unknown }).daily_room_name !== "string"
    ) {
      throw new Error("Daily room claim returned an invalid response.");
    }

    const roomClaim = claim as {
      should_create: boolean;
      daily_room_name: string;
      daily_room_url: string | null;
    };
    if (roomClaim.daily_room_url) {
      roomUrl = roomClaim.daily_room_url;
    } else if (roomClaim.should_create) {
      try {
        roomUrl = await createDailyRoom(roomClaim.daily_room_name);
        const { data: saved, error: saveError } = await admin.rpc(
          "save_daily_room",
          {
            p_match_id: match.id,
            p_user_id: userId,
            p_room_url: roomUrl,
          },
        );
        if (saveError || saved !== true) {
          throw saveError ?? new Error("Daily room could not be saved.");
        }
      } catch (error) {
        await admin.rpc("fail_daily_room", {
          p_match_id: match.id,
          p_user_id: userId,
        });
        throw error;
      }
    } else {
      return null;
    }
  }

  const { data: profile, error: profileError } = await admin
    .from("guest_profiles")
    .select("display_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile?.display_name) throw new Error("Guest profile not found.");

  const meetingToken = await createDailyMeetingToken(
    match.daily_room_name,
    profile.display_name,
  );
  return { roomUrl, meetingToken };
}
