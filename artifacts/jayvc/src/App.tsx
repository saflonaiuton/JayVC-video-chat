import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import DailyIframe from '@daily-co/daily-js';
import {
  useGetJayvcConfig,
  getGetJayvcConfigQueryKey,
  useCreateGuestProfile,
  useJoinMatchmakingQueue,
  useGetMatchmakingStatus,
  getGetMatchmakingStatusQueryKey,
  useLeaveMatchmakingQueue,
  useSubmitGuestReport,
  setAuthTokenGetter,
} from '@workspace/api-client-react';
import type { GuestReportInputReason, MatchStatus } from '@workspace/api-client-react';
import {
  ArrowDownRight,
  ArrowRight,
  BadgeCheck,
  Camera,
  Check,
  CircleHelp,
  Headphones,
  LockKeyhole,
  MessageCircle,
  Mic,
  MicOff,
  Plus,
  Send,
  Shield,
  ShieldAlert,
  Sparkles,
  Video,
  VideoOff,
  X,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

type Phase =
  | 'pre-call'
  | 'requesting'
  | 'denied'
  | 'waiting'
  | 'connected'
  | 'reconnecting'
  | 'partner-disconnected'
  | 'ending'
  | 'report-submitted'
  | 'unavailable'
  | 'demo';
type Message = { id: number; text: string; own: boolean; name: string };
type DailyParticipant = {
  local?: boolean;
  tracks?: { video?: { persistentTrack?: MediaStreamTrack }; audio?: { persistentTrack?: MediaStreamTrack } };
};
type DailyCall = {
  on: (event: string, callback: (event?: { participant?: DailyParticipant; participants?: Record<string, DailyParticipant>; data?: unknown; fromId?: string }) => void) => DailyCall;
  join: (options: { url: string; token: string }) => Promise<void>;
  leave: () => Promise<void>;
  destroy: () => Promise<void> | void;
  setLocalVideo: (enabled: boolean) => void;
  setLocalAudio: (enabled: boolean) => void;
  sendAppMessage: (data: unknown, recipient?: string) => void;
  participants: () => Record<string, DailyParticipant>;
};
const queryClient = new QueryClient();
const faqItems = [
  {
    q: 'What happens when I start?',
    a: 'JayVC checks your camera and microphone permission only after you press Start. If the service is live, we create or resume an anonymous guest session and look for someone whose preferences match yours in both directions.',
  },
  {
    q: 'Are there real people online right now?',
    a: 'We do not publish a live count or promise that someone is available. When the service is live, the waiting status comes from the matchmaking service. If the service is in demo mode, it is labelled clearly and no real partner is connected.',
  },
  {
    q: 'Who can see my gender and match preference?',
    a: 'Your gender and match choice are used privately for reciprocal matching. They are not displayed to the other person and are not saved in your browser storage.',
  },
  {
    q: 'Are messages saved?',
    a: 'Text messages exist only for the current page session and are not written to local storage. Leaving or refreshing the page clears them.',
  },
  {
    q: 'Can I stop a conversation at any time?',
    a: 'Yes. End closes the current conversation. Next is a separate action that ends the current match and starts a new search. You can also mute your microphone or turn off your camera while connected.',
  },
  {
    q: 'How do I report a concern?',
    a: 'Use Report during an active match, choose the closest reason and add optional details. If someone appears to be under 18, end the conversation and select Underage in the report form.',
  },
];

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <RoutedErrorBoundary>
            <Switch>
              <Route path="/" component={JayvcHome} />
              <Route component={NotFound} />
            </Switch>
          </RoutedErrorBoundary>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function JayvcHome() {
  const configQuery = useGetJayvcConfig({ query: { queryKey: getGetJayvcConfigQueryKey() } });
  const config = configQuery.data;
  const liveReady = config?.mode === 'live' && config.supabaseReady && config.dailyReady;
  const supabaseRef = useRef<SupabaseClient | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dailyRef = useRef<DailyCall | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const reportTriggerRef = useRef<HTMLButtonElement | null>(null);
  const nextInFlight = useRef(false);
  const joinedMatchRef = useRef<string | null>(null);
  const messageSequenceRef = useRef(0);
  const realtimeChannelRef = useRef<ReturnType<SupabaseClient['channel']> | null>(null);
  const realtimeRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);
  const queryClient = useQueryClient();
  const createProfile = useCreateGuestProfile();
  const joinQueue = useJoinMatchmakingQueue();
  const leaveQueue = useLeaveMatchmakingQueue();
  const submitReport = useSubmitGuestReport();
  const [adultConfirmed, setAdultConfirmed] = useState(false);
  const [gender, setGender] = useState<'Male' | 'Female'>('Male');
  const [matchWith, setMatchWith] = useState<'Male' | 'Female'>('Female');
  const [phase, setPhase] = useState<Phase>('pre-call');
  const [phaseMessage, setPhaseMessage] = useState('');
  const [guestName, setGuestName] = useState('');
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState<GuestReportInputReason>('inappropriate');
  const [reportDetails, setReportDetails] = useState('');
  const [reportError, setReportError] = useState('');
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [remoteReady, setRemoteReady] = useState(false);
  const liveCall = phase === 'connected' || phase === 'reconnecting' || phase === 'partner-disconnected' || phase === 'report-submitted';
  const activeQueue = phase === 'waiting' || liveCall;
  const statusQuery = useGetMatchmakingStatus({
    query: {
      enabled: Boolean(liveReady && phase === 'waiting'),
      queryKey: getGetMatchmakingStatusQueryKey(),
      refetchInterval: phase === 'waiting' && !realtimeConnected ? 5000 : false,
    },
  });
  const refetchStatusRef = useRef(statusQuery.refetch);
  refetchStatusRef.current = statusQuery.refetch;

  useEffect(() => {
    const video = localVideoRef.current;
    if (video && streamRef.current) video.srcObject = streamRef.current;
  }, [phase, cameraOn]);

  useEffect(() => {
    const status = statusQuery.data;
    if (!status || !liveReady || !activeQueue) return;
    if (status.state === 'waiting') {
      setPhase('waiting');
      setPhaseMessage(status.message ?? 'Looking for someone whose preferences match yours.');
    } else if (status.state === 'unavailable') {
      setPhase('unavailable');
      setPhaseMessage(status.message ?? 'Matching is not available right now. Please try again later.');
    } else if (status.state === 'disconnected') {
      setPhase('partner-disconnected');
      setPhaseMessage(status.message ?? 'The other guest left the conversation.');
    } else if (status.state === 'matched' && status.roomUrl && status.meetingToken && status.matchId) {
      setMatchId(status.matchId);
      if (status.displayName) setGuestName(status.displayName);
      setPhaseMessage('A match is ready. Connecting securely…');
      void connectDaily(status);
    }
    // connectDaily uses the current API-provided room credentials only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusQuery.data, liveReady, activeQueue]);

  useEffect(() => {
    const client = supabaseRef.current;
    if (!liveReady || phase !== 'waiting' || !client || !authUserId) {
      setRealtimeConnected(false);
      if (realtimeRetryRef.current) clearTimeout(realtimeRetryRef.current);
      if (realtimeChannelRef.current && client) {
        void client.removeChannel(realtimeChannelRef.current);
        realtimeChannelRef.current = null;
      }
      return;
    }

    let disposed = false;
    let retryCount = 0;
    const subscribeToOwnQueue = () => {
      if (disposed) return;
      if (realtimeChannelRef.current) {
        void client.removeChannel(realtimeChannelRef.current);
        realtimeChannelRef.current = null;
      }
      const channel = client
        .channel(`jayvc-queue-${authUserId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'matchmaking_queue',
            filter: `user_id=eq.${authUserId}`,
          },
          () => {
            if (!disposed) void refetchStatusRef.current();
          },
        )
        .subscribe((status) => {
          if (disposed) return;
          if (status === 'SUBSCRIBED') {
            retryCount = 0;
            setRealtimeConnected(true);
            void refetchStatusRef.current();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            setRealtimeConnected(false);
            if (realtimeRetryRef.current) clearTimeout(realtimeRetryRef.current);
            const delay = Math.min(1000 * (2 ** retryCount), 12000);
            retryCount += 1;
            realtimeRetryRef.current = setTimeout(subscribeToOwnQueue, delay);
          }
        });
      realtimeChannelRef.current = channel;
    };

    subscribeToOwnQueue();
    return () => {
      disposed = true;
      setRealtimeConnected(false);
      if (realtimeRetryRef.current) clearTimeout(realtimeRetryRef.current);
      realtimeRetryRef.current = null;
      if (realtimeChannelRef.current) {
        void client.removeChannel(realtimeChannelRef.current);
        realtimeChannelRef.current = null;
      }
    };
  }, [authUserId, liveReady, phase, queryClient]);

  async function connectDaily(status: MatchStatus) {
    if (!status.roomUrl || !status.meetingToken || !status.matchId || joinedMatchRef.current === status.matchId) return;
    joinedMatchRef.current = status.matchId;
    try {
      const call = DailyIframe.createCallObject() as unknown as DailyCall;
      dailyRef.current = call;
      call.on('joined-meeting', () => {
        call.setLocalVideo(cameraOn);
        call.setLocalAudio(micOn);
        const partnerIsPresent = Object.values(call.participants()).some((participant) => !participant.local);
        if (partnerIsPresent) {
          setPhase('connected');
          setPhaseMessage(`Connected with ${status.displayName || 'your match'}.`);
        } else {
          setPhase('waiting');
          setPhaseMessage('Your room is ready. Waiting for the other person to connect…');
        }
      });
      call.on('participant-joined', (event) => {
        const participant = event?.participant;
        if (participant?.local) return;
        setPhase('connected');
        setPhaseMessage(`Connected with ${status.displayName || 'your match'}.`);
        setRemoteReady(true);
      });
      call.on('participant-updated', (event) => {
        const participant = event?.participant;
        if (!participant || participant.local) return;
        const track = participant.tracks?.video?.persistentTrack;
        if (track && remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = new MediaStream([track]);
          setRemoteReady(true);
          setPhase('connected');
          setPhaseMessage(`Connected with ${status.displayName || 'your match'}.`);
        }
      });
      call.on('participant-left', (event) => {
        if (event?.participant?.local) return;
        setPhase('partner-disconnected');
        setPhaseMessage('The other person has disconnected. You can report or end this conversation.');
        setRemoteReady(false);
      });
      call.on('error', () => {
        setPhase('reconnecting');
        setPhaseMessage('The connection was interrupted. Trying to reconnect…');
      });
      call.on('app-message', (event) => {
        if (event?.fromId === 'local' || !event?.data || typeof event.data !== 'object') return;
        const incoming = event.data as { type?: string; text?: string };
        if (incoming.type !== 'chat' || typeof incoming.text !== 'string' || !incoming.text.trim()) return;
        setMessages((current) => [...current, { id: ++messageSequenceRef.current, text: incoming.text!.slice(0, 500), own: false, name: status.displayName || 'Guest' }]);
      });
      call.on('network-connection', () => {
        setPhase((current) => current === 'connected' ? 'reconnecting' : current);
        setPhaseMessage('The connection was interrupted. Waiting for it to recover…');
      });
      await call.join({ url: status.roomUrl, token: status.meetingToken });
    } catch {
      setPhase('unavailable');
      setPhaseMessage('The call could not be connected. Your camera and microphone remain under your control.');
    }
  }

  useEffect(() => {
    if (localVideoRef.current && streamRef.current) localVideoRef.current.srcObject = streamRef.current;
  }, [cameraOn, phase]);

  useEffect(() => {
    if (!reportOpen) return;
    const focusTarget = document.querySelector<HTMLButtonElement>('[data-testid="button-close-report"]');
    focusTarget?.focus();
    const handleKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setReportOpen(false);
      }
      if (event.key === 'Tab') {
        const focusable = document.querySelectorAll<HTMLElement>('[data-testid="dialog-report"] button:not(:disabled), [data-testid="dialog-report"] select, [data-testid="dialog-report"] textarea');
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeys);
    return () => {
      document.removeEventListener('keydown', handleKeys);
      reportTriggerRef.current?.focus();
    };
  }, [reportOpen]);

  useEffect(() => {
    return () => {
      void dailyRef.current?.leave();
      void dailyRef.current?.destroy();
      stopStream();
      setAuthTokenGetter(null);
    };
  }, [stopStream]);

  const ensureGuestSession = async () => {
    if (!config?.supabaseUrl || !config.supabaseAnonKey) throw new Error('Anonymous guest sessions are not configured.');
    if (!supabaseRef.current) {
      supabaseRef.current = createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      });
    }
    const client = supabaseRef.current;
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw sessionError;
    let accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      const { data, error } = await client.auth.signInAnonymously();
      if (error) throw error;
      accessToken = data.session?.access_token;
    }
    if (!accessToken) throw new Error('A guest session could not be established.');
    setAuthTokenGetter(async () => {
      const { data } = await client.auth.getSession();
      return data.session?.access_token ?? null;
    });
    const { data: userData, error: userError } = await client.auth.getUser();
    if (userError || !userData.user?.id) throw userError ?? new Error('The anonymous guest identity could not be verified.');
    setAuthUserId(userData.user.id);
    return client;
  };

  const submitQueue = async () => {
    const result = await joinQueue.mutateAsync({ data: { gender, matchWith } });
    queryClient.setQueryData(getGetMatchmakingStatusQueryKey(), result);
    if (result.state === 'waiting') {
      setPhase('waiting');
      setPhaseMessage(result.message ?? 'Looking for someone whose preferences match yours.');
    } else if (result.state === 'matched' && result.roomUrl && result.meetingToken && result.matchId) {
      setPhase('waiting');
      setMatchId(result.matchId);
      if (result.displayName) setGuestName(result.displayName);
      void connectDaily(result);
    } else if (result.state === 'unavailable') {
      setPhase('unavailable');
      setPhaseMessage(result.message ?? 'Matching is not available right now.');
    } else {
      setPhase('waiting');
      setPhaseMessage(result.message ?? 'Your request was received. Waiting for a reciprocal match.');
    }
  };

  const handleStart = async () => {
    if (!adultConfirmed || configQuery.isLoading || !config) return;
    setMessages([]);
    setMatchId(null);
    setRemoteReady(false);
    joinedMatchRef.current = null;
    setPhaseMessage('');
    if (!liveReady) {
      setPhase('demo');
      setPhaseMessage('Demo mode only. There is no real partner, call, or matchmaking session.');
      return;
    }
    setPhase('requesting');
    setPhaseMessage('Requesting camera and microphone access after your Start action…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      const client = await ensureGuestSession();
      const profile = await createProfile.mutateAsync();
      setGuestName(profile.displayName);
      await submitQueue();
      void client;
    } catch (error) {
      stopStream();
      setPhase(error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') ? 'denied' : 'unavailable');
      setPhaseMessage(
        error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError')
          ? 'Camera or microphone permission was denied. You can change browser permissions and try again.'
          : error instanceof Error ? error.message : 'The service could not be reached. Please try again.',
      );
    }
  };

  const endCurrent = async (next = false) => {
    if (nextInFlight.current) return;
    nextInFlight.current = true;
    setPhase('ending');
    setPhaseMessage(next ? 'Ending this match before starting another search…' : 'Ending this conversation…');
    setRemoteReady(false);
    setMessages([]);
    try {
      await dailyRef.current?.leave();
      await dailyRef.current?.destroy();
      dailyRef.current = null;
      await leaveQueue.mutateAsync();
    } catch {
      // The local call is still closed; surface a useful state below.
    }
    joinedMatchRef.current = null;
    setMatchId(null);
    if (next && liveReady) {
      try {
        await submitQueue();
      } catch (error) {
        setPhase('unavailable');
        setPhaseMessage(error instanceof Error ? error.message : 'A new search could not be started.');
      }
    } else {
      stopStream();
      setPhase('pre-call');
      setPhaseMessage('');
    }
    nextInFlight.current = false;
  };

  const toggleCamera = () => {
    const next = !cameraOn;
    setCameraOn(next);
    streamRef.current?.getVideoTracks().forEach((track) => { track.enabled = next; });
    dailyRef.current?.setLocalVideo(next);
  };
  const toggleMic = () => {
    const next = !micOn;
    setMicOn(next);
    streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = next; });
    dailyRef.current?.setLocalAudio(next);
  };
  const sendMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || phase !== 'connected') return;
    try {
      dailyRef.current?.sendAppMessage({ type: 'chat', text }, '*');
      setMessages((current) => [...current, { id: ++messageSequenceRef.current, text, own: true, name: guestName || 'You' }]);
    } catch {
      setPhaseMessage('The text message could not be sent. Please try again.');
      return;
    }
    setDraft('');
  };
  const sendReport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!matchId) {
      setReportError('There is no active match to report.');
      return;
    }
    setReportError('');
    try {
      const data: { reason: GuestReportInputReason; details?: string } = { reason: reportReason };
      if (reportDetails.trim()) data.details = reportDetails.trim().slice(0, 500);
      await submitReport.mutateAsync({ data });
      setReportOpen(false);
      setReportDetails('');
      setPhase('report-submitted');
      setPhaseMessage('Report submitted. Thank you for helping keep conversations safer.');
    } catch (error) {
      setReportError(error instanceof Error ? error.message : 'Your report could not be submitted. Please try again.');
    }
  };
  const setGenderPreference = (value: 'Male' | 'Female') => {
    setGender(value);
    setMatchWith(value === 'Male' ? 'Female' : 'Male');
  };

  const callIsPrestart = phase === 'pre-call';
  const hasMedia = liveCall || phase === 'waiting';
  const statusLabel: Record<Phase, string> = {
    'pre-call': 'Ready when you are',
    requesting: 'Requesting permission',
    denied: 'Permission denied',
    waiting: 'Waiting for a reciprocal match',
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    'partner-disconnected': 'Other person disconnected',
    ending: 'Ending conversation',
    'report-submitted': 'Report submitted',
    unavailable: 'Unavailable',
    demo: 'Demo mode',
  };
  const cardIsDemo = Boolean(config && (config.mode === 'demo' || !config.supabaseReady || !config.dailyReady));

  return (
    <main className="site-shell" data-testid="page-jayvc-home">
      <header className="site-header" data-testid="header-persistent-navigation">
        <div className="container-wide header-inner">
          <a className="brand" href="#top" data-testid="link-jayvc-home" aria-label="JayVC home">
            <span className="brand-mark" aria-hidden="true">J</span><span>jayvc</span>
          </a>
          <nav className="nav-links" aria-label="Main navigation" data-testid="nav-main">
            <a href="#how-it-works" data-testid="link-how-it-works">How it works</a>
            <a href="#safety" data-testid="link-safety">Safety</a>
            <a href="#faq" data-testid="link-faq">FAQ</a>
            <a className="nav-cta" href="#chatbox" data-testid="link-start-chat">Go to chat <ArrowRight size={15} aria-hidden="true" /></a>
          </nav>
        </div>
      </header>

      <section className="hero" id="top" data-testid="section-hero">
        <div className="container-wide hero-grid">
          <div className="reveal">
            <div className="eyebrow" data-testid="text-hero-kicker">A little more human, one conversation at a time</div>
            <h1 data-testid="heading-hero">Meet in the <em>moment.</em></h1>
            <p className="hero-copy" data-testid="text-hero-description">
              A spontaneous one-to-one video conversation for adults. Choose your preferences, decide when to begin, and leave whenever you like.
            </p>
            <div className="hero-actions">
              <a className="button-primary" href="#chatbox" data-testid="link-hero-start">Start a conversation <ArrowDownRight size={16} aria-hidden="true" /></a>
              <span className="hero-note" data-testid="text-hero-no-pressure"><LockKeyhole size={14} aria-hidden="true" /> No account form. No pressure.</span>
            </div>
          </div>
          <div className="hero-art reveal delay-1" aria-label="Abstract illustration of two overlapping horizons">
            <span className="orbit" aria-hidden="true"></span>
            <span className="orbit two" aria-hidden="true"></span>
            <span className="sun-disc" aria-hidden="true"></span>
            <Sparkles className="art-spark" size={21} style={{ top: '19%', left: '13%' }} aria-hidden="true" />
            <Sparkles className="art-spark" size={13} style={{ bottom: '22%', right: '12%' }} aria-hidden="true" />
            <span className="art-label top">A conversation, not a commitment</span>
            <span className="art-label bottom">One person at a time</span>
            <span className="hero-caption">Your next hello is entirely up to you.</span>
          </div>
        </div>
      </section>

      <section className="trust-strip" aria-label="Service principles" data-testid="section-service-principles">
        <div className="container-wide trust-inner">
          <span className="trust-item" data-testid="text-principle-adults"><BadgeCheck size={16} /> Adults only</span>
          <span className="trust-item" data-testid="text-principle-private"><LockKeyhole size={15} /> Preferences stay private</span>
          <span className="trust-item" data-testid="text-principle-control"><Shield size={16} /> Leave or report at any time</span>
          <span className="trust-item" data-testid="text-principle-reciprocal"><MessageCircle size={15} /> Reciprocal matching</span>
        </div>
      </section>

      <section className="section how-section" id="how-it-works" data-testid="section-how-it-works">
        <div className="container-wide how-grid">
          <div>
            <div className="section-kicker">How it works</div>
            <h2 className="section-heading" data-testid="heading-how">Simple by design.<br />Always your choice.</h2>
            <p className="section-intro" data-testid="text-how-intro">No profile to build and no expectation to stay. You decide what feels comfortable, from the first click onward.</p>
          </div>
          <div className="steps" data-testid="list-how-steps">
            <article className="step" data-testid="step-how-1">
              <span className="step-num">01</span><div><h3>Confirm you are an adult</h3><p>JayVC is for adults aged 18 and over. You must acknowledge this before you can start.</p></div>
            </article>
            <article className="step" data-testid="step-how-2">
              <span className="step-num">02</span><div><h3>Set private preferences</h3><p>Choose Male or Female and who you want to meet. The service only looks for a match when both people's choices fit.</p></div>
            </article>
            <article className="step" data-testid="step-how-3">
              <span className="step-num">03</span><div><h3>Start when you are ready</h3><p>Your browser asks for camera and microphone access only after you press Start. Nothing is requested in advance.</p></div>
            </article>
            <article className="step" data-testid="step-how-4">
              <span className="step-num">04</span><div><h3>Stay, move on, or end</h3><p>Keep talking, use Next to begin another search, or choose End to leave without starting over.</p></div>
            </article>
          </div>
        </div>
      </section>

      <section className="chat-section" id="chatbox" data-testid="section-chatbox">
        <div className="container-wide chat-layout">
          <div className="chat-intro">
            <div className="section-kicker">The conversation starts here</div>
            <h2 className="section-heading" data-testid="heading-chat">Find a good moment to say hello.</h2>
            <p className="section-intro" data-testid="text-chat-intro">Take a breath. Set your preferences. When you press Start, JayVC will tell you exactly what is happening.</p>
            <div className="privacy-note" id="privacy" data-testid="text-chat-privacy-note">
              <LockKeyhole size={18} aria-hidden="true" />
              <span><strong>Your preferences are private.</strong> Messages stay in this tab only. This experience does not write chat messages or gender preferences to browser storage.</span>
            </div>
          </div>

          <section className="chat-card" aria-labelledby="chat-card-heading" data-testid="card-chat-experience">
            <div className="chat-topline">
              <div className="chat-brandline"><span className="live-dot" aria-hidden="true"></span><span id="chat-card-heading">JayVC one-to-one</span></div>
              {cardIsDemo && <span className="demo-pill" data-testid="badge-demo-mode">Demo mode</span>}
            </div>
            <div className="call-content">
              {callIsPrestart && (
                <>
                  <label className="adult-check" data-testid="label-adult-acknowledgement">
                    <input
                      type="checkbox"
                      checked={adultConfirmed}
                      onChange={(event) => setAdultConfirmed(event.target.checked)}
                      data-testid="input-adult-acknowledgement"
                    />
                    <span>I confirm that I am 18 years of age or older and agree to follow the community rules.</span>
                  </label>
                  <div className="prefs">
                    <label>
                      <span className="field-label">I am</span>
                      <select className="select-control" value={gender} onChange={(event) => setGenderPreference(event.target.value as 'Male' | 'Female')} data-testid="select-gender">
                        <option value="Male">Male</option><option value="Female">Female</option>
                      </select>
                    </label>
                    <label>
                      <span className="field-label">Match with</span>
                      <select className="select-control" value={matchWith} onChange={(event) => setMatchWith(event.target.value as 'Male' | 'Female')} data-testid="select-match-with">
                        <option value="Male">Male</option><option value="Female">Female</option>
                      </select>
                    </label>
                  </div>
                  <p className="private-hint" data-testid="text-preferences-private"><LockKeyhole size={13} aria-hidden="true" /> Your gender and match choice are private, used only for reciprocal matching.</p>
                  <div className="start-row">
                    <button className="button-primary" onClick={handleStart} disabled={!adultConfirmed || configQuery.isLoading || !config || createProfile.isPending || joinQueue.isPending} data-testid="button-start">
                      {configQuery.isLoading ? 'Checking availability…' : createProfile.isPending ? 'Preparing your guest session…' : 'Start'} <ArrowRight size={16} aria-hidden="true" />
                    </button>
                    {configQuery.isError && <button className="button-secondary" onClick={() => void configQuery.refetch()} data-testid="button-retry-config">Retry</button>}
                  </div>
                  {configQuery.isLoading && <div className="status-box info" role="status" data-testid="status-config-loading">Checking service availability…</div>}
                  {configQuery.isError && <div className="status-box error" role="alert" data-testid="status-config-error">Availability could not be checked. Start is paused until the service responds.</div>}
                  {(phase === 'denied' || phase === 'unavailable') && phaseMessage && <div className="status-box error" role="alert" data-testid="status-precall-result">{phaseMessage}</div>}
                </>
              )}

              {!callIsPrestart && (
                <>
                  <div className="call-stage" data-testid="region-call-stage">
                    <video ref={remoteVideoRef} autoPlay playsInline aria-label="Your conversation partner's video" hidden={!remoteReady || (phase !== 'connected' && phase !== 'report-submitted')} />
                    {(phase !== 'connected' && phase !== 'report-submitted' || !remoteReady) && (
                      <div className="call-stage-placeholder">
                        <span className="stage-icon" aria-hidden="true">{phase === 'demo' ? <ShieldAlert size={21} /> : phase === 'waiting' || phase === 'requesting' ? <Headphones size={21} /> : <CircleHelp size={21} />}</span>
                        <strong data-testid="text-call-stage-title">{phase === 'demo' ? 'Demo preview only' : phase === 'waiting' ? 'Waiting for a reciprocal match' : phase === 'requesting' ? 'Preparing your connection' : phase === 'connected' || phase === 'report-submitted' ? 'Connected — waiting for video' : statusLabel[phase]}</strong>
                        <p data-testid="text-call-stage-description">{phase === 'demo' ? 'No real partner is connected. No call or matchmaking session is active.' : phaseMessage || 'Your camera and microphone remain under your control.'}</p>
                      </div>
                    )}
                    {hasMedia && <video ref={localVideoRef} autoPlay playsInline muted hidden={!cameraOn} aria-label="Your camera preview" className="local-preview" data-testid="video-local-preview" />}
                  </div>
                  <div className="call-controls" aria-label="Call controls" data-testid="group-call-controls">
                    <button className={`control-button ${!micOn ? 'is-off' : ''}`} onClick={toggleMic} disabled={!hasMedia} aria-pressed={!micOn} data-testid="button-toggle-microphone">
                      {micOn ? <Mic size={15} /> : <MicOff size={15} />} {micOn ? 'Mute' : 'Unmute'}
                    </button>
                    <button className={`control-button ${!cameraOn ? 'is-off' : ''}`} onClick={toggleCamera} disabled={!hasMedia} aria-pressed={!cameraOn} data-testid="button-toggle-camera">
                      {cameraOn ? <Video size={15} /> : <VideoOff size={15} />} {cameraOn ? 'Camera on' : 'Camera off'}
                    </button>
                    {liveCall && (
                      <>
                        <button ref={reportTriggerRef} className="control-button" onClick={() => setReportOpen(true)} disabled={!matchId || submitReport.isPending} data-testid="button-open-report"><ShieldAlert size={15} /> Report</button>
                        <button className="control-button" onClick={() => void endCurrent(true)} disabled={nextInFlight.current} data-testid="button-next"><ArrowRight size={15} /> Next</button>
                        <button className="control-button end" onClick={() => void endCurrent(false)} disabled={nextInFlight.current} data-testid="button-end"><X size={15} /> End</button>
                      </>
                    )}
                    {phase === 'waiting' && <button className="control-button end" onClick={() => void endCurrent(false)} data-testid="button-cancel-search"><X size={15} /> End search</button>}
                    {phase === 'demo' && <button className="control-button" onClick={() => { setPhase('pre-call'); setPhaseMessage(''); }} data-testid="button-exit-demo">Back to setup</button>}
                    {phase === 'denied' && <button className="control-button" onClick={() => setPhase('pre-call')} data-testid="button-dismiss-denied">Back to setup</button>}
                    {phase === 'unavailable' && <button className="control-button" onClick={() => { void configQuery.refetch(); setPhase('pre-call'); }} data-testid="button-retry-call">Try again</button>}
                    {phase === 'report-submitted' && <button className="control-button" onClick={() => setPhase('pre-call')} data-testid="button-dismiss-report-success">Back to setup</button>}
                  </div>
                  {phase === 'demo' && <div className="status-box info" role="status" data-testid="status-demo-not-connected">Demo mode: this is not a live call. No real partner is connected, and Start will not request camera or microphone access.</div>}
                  {phaseMessage && phase !== 'demo' && <div className={`status-box ${phase === 'denied' || phase === 'unavailable' ? 'error' : 'info'}`} role={phase === 'denied' || phase === 'unavailable' ? 'alert' : 'status'} data-testid="status-call">{phaseMessage}</div>}
                  {phase === 'waiting' && <p className="private-hint" role="status" data-testid="status-matchmaking-connection">{realtimeConnected ? 'Live queue updates are connected.' : 'Using status refresh while live queue updates connect.'}</p>}
                  {phase === 'waiting' && statusQuery.isError && <div className="status-box error" role="alert" data-testid="status-matchmaking-error">Match status could not be refreshed. We will keep trying in the background.<button className="button-quiet" onClick={() => void statusQuery.refetch()} data-testid="button-retry-status">Retry status</button></div>}
                  {liveCall && phase === 'connected' && (
                    <div className="text-chat" data-testid="region-text-chat">
                      <div className="chat-messages" role="log" aria-label="Conversation messages" aria-live="polite" data-testid="list-chat-messages">
                        {messages.length === 0 && <span className="sr-only" data-testid="text-chat-empty">No messages yet.</span>}
                        {messages.map((message) => (
                          <div className={`message-bubble ${message.own ? 'own' : ''}`} key={message.id} data-testid={`message-chat-${message.id}`}>
                            <span className="message-author">{message.name}</span>{message.text}
                          </div>
                        ))}
                      </div>
                      <form className="message-form" onSubmit={sendMessage} data-testid="form-send-message">
                        <label className="sr-only" htmlFor="chat-message">Write a message</label>
                        <input id="chat-message" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={500} placeholder="Write a message…" data-testid="input-chat-message" />
                        <button type="submit" disabled={!draft.trim()} aria-label="Send message" data-testid="button-send-message"><Send size={16} /></button>
                      </form>
                      <div className="sr-only" role="status" aria-live="polite" data-testid="status-chat-messages">{messages.length ? `${messages.length} message${messages.length === 1 ? '' : 's'} in this conversation.` : 'No messages yet.'}</div>
                    </div>
                  )}
                </>
              )}
              <div className="sr-only" role="status" aria-live="polite" data-testid="status-call-phase">{statusLabel[phase]}{phaseMessage ? `: ${phaseMessage}` : ''}</div>
            </div>
          </section>
        </div>
      </section>

      <section className="rules-band" id="safety" data-testid="section-safety">
        <div className="container-wide rules-grid">
          <div>
            <div className="section-kicker">A shared responsibility</div>
            <h2 className="section-heading" data-testid="heading-safety">Good conversations need clear boundaries.</h2>
            <p className="section-intro" data-testid="text-safety-intro">JayVC is for adults who want a respectful, one-to-one conversation. If something feels wrong, you never owe anyone more of your time.</p>
          </div>
          <ul className="rule-list" data-testid="list-community-rules">
            <li data-testid="rule-adults-only"><BadgeCheck size={18} aria-hidden="true" /><span><strong>Adults only.</strong> You must be 18 or older. Do not misrepresent your age.</span></li>
            <li data-testid="rule-consent"><Shield size={18} aria-hidden="true" /><span><strong>Respect consent.</strong> No harassment, threats, sexual misconduct, or unwanted behavior.</span></li>
            <li data-testid="rule-personal-info"><LockKeyhole size={18} aria-hidden="true" /><span><strong>Protect personal information.</strong> Avoid sharing addresses, financial details, or identifying information.</span></li>
            <li data-testid="rule-report"><ShieldAlert size={18} aria-hidden="true" /><span><strong>Use the controls.</strong> End the conversation, move on, or report a concern whenever you need to.</span></li>
            <li data-testid="rule-recording"><Camera size={18} aria-hidden="true" /><span><strong>Respect privacy.</strong> Do not record, capture, or redistribute another person's conversation without their consent.</span></li>
          </ul>
        </div>
      </section>

      <section className="section faq-section" id="faq" data-testid="section-faq">
        <div className="container-wide faq-layout">
          <div>
            <div className="section-kicker">Before you begin</div>
            <h2 className="section-heading" data-testid="heading-faq">A few things worth knowing.</h2>
            <p className="section-intro" data-testid="text-faq-intro">Clear answers, no fine-print surprises.</p>
          </div>
          <div className="faq-list" data-testid="list-faq">
            {faqItems.map((item, index) => (
              <details className="faq-item" key={item.q} data-testid={`faq-item-${index + 1}`}>
                <summary data-testid={`faq-question-${index + 1}`}>{item.q}<Plus size={17} aria-hidden="true" /></summary>
                <div className="faq-answer" data-testid={`faq-answer-${index + 1}`}>{item.a}</div>
              </details>
            ))}
          </div>
        </div>
      </section>

      <footer className="footer" data-testid="footer-site">
        <div className="container-wide">
          <div className="footer-inner">
            <div className="footer-brand">
              <a className="brand" href="#top" data-testid="link-footer-home"><span className="brand-mark" aria-hidden="true">J</span><span>jayvc</span></a>
              <small data-testid="text-footer-tagline">One conversation at a time. Adults only.</small>
            </div>
            <nav className="footer-links" aria-label="Legal and support links" data-testid="nav-footer">
              <a href="#privacy" data-testid="link-privacy">Privacy</a>
              <a href="#terms" data-testid="link-terms">Terms &amp; community rules</a>
              <a href="mailto:hello@jayvc.com?subject=JayVC%20support" data-testid="link-contact">Contact</a>
              <a href="#safety" data-testid="link-footer-safety">Safety</a>
            </nav>
          </div>
          <p className="footer-note" id="terms" data-testid="text-footer-note">Terms summary: JayVC is for adults aged 18 and over. By using the service, you agree to follow the community rules above. Availability depends on reciprocal preferences and service readiness; a match is never guaranteed.</p>
        </div>
      </footer>

      {reportOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setReportOpen(false); }} data-testid="dialog-report-backdrop">
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="report-title" aria-describedby="report-description" data-testid="dialog-report">
            <div className="modal-head">
              <div><h2 id="report-title" data-testid="heading-report">Report a concern</h2><p id="report-description" data-testid="text-report-description">Your report is sent to the service for review. Do not include sensitive personal information.</p></div>
              <button className="icon-button" onClick={() => setReportOpen(false)} aria-label="Close report form" data-testid="button-close-report"><X size={17} /></button>
            </div>
            <form className="report-form" onSubmit={sendReport} data-testid="form-report">
              <label className="field-label" htmlFor="report-reason">Reason</label>
              <select id="report-reason" value={reportReason} onChange={(event) => setReportReason(event.target.value as GuestReportInputReason)} data-testid="select-report-reason">
                <option value="inappropriate">Inappropriate behavior</option>
                <option value="harassment">Harassment</option>
                <option value="underage">Underage person</option>
                <option value="spam">Spam</option>
                <option value="other">Other</option>
              </select>
              <label className="field-label" htmlFor="report-details">Details <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>— optional, up to 500 characters</span></label>
              <textarea id="report-details" value={reportDetails} maxLength={500} onChange={(event) => setReportDetails(event.target.value)} data-testid="textarea-report-details" />
              {reportError && <p className="status-box error" role="alert" data-testid="text-report-error">{reportError}</p>}
              <div className="modal-actions">
                <button type="button" className="button-secondary" onClick={() => setReportOpen(false)} data-testid="button-cancel-report">Cancel</button>
                <button type="submit" className="button-primary" disabled={submitReport.isPending} data-testid="button-submit-report">{submitReport.isPending ? 'Submitting…' : 'Submit report'} <Check size={15} /></button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
