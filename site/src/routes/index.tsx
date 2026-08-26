import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { signupForWaitlist, type WaitlistResult } from "~/lib/waitlist";

export const Route = createFileRoute("/")({
  component: Home,
});

function VantageMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" className="fill-fuchsia-500" />
      <path
        d="M9 9.5v5l4.5-2.5L9 9.5Z"
        className="fill-white"
      />
      <circle cx="12" cy="12" r="2.4" className="fill-white/90" />
    </svg>
  );
}

function Home() {
  return (
    <div className="flex min-h-dvh flex-col bg-white text-gray-900">
      <Nav />
      <main className="flex-1">
        <Hero />
        <HowItWorks />
        <Modes />
        <Waitlist />
      </main>
      <Footer />
    </div>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-20 border-b border-gray-100 bg-white/80 backdrop-blur">
      <nav className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-4">
        <a href="#" className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <VantageMark className="h-7 w-7" />
          Vantage
        </a>
        <a
          href="/solo"
          className="rounded-full bg-gradient-to-r from-fuchsia-500 to-indigo-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
        >
          Make a solo video
        </a>
        <a
          href="/app/create"
          className="rounded-full border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
        >
          Start an event
        </a>
      </nav>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 -z-10"
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(60% 60% at 50% 0%, #f5d0fe 0%, rgba(255,255,255,0) 70%)",
        }}
      />
      <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-5 pb-16 pt-14 sm:pt-20 lg:grid-cols-2 lg:gap-16">
        <div className="text-center lg:text-left">
          <span className="inline-flex items-center gap-2 rounded-full bg-fuchsia-100 px-3 py-1 text-xs font-semibold text-fuchsia-700">
            <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-500" />
            No editing skill required
          </span>
          <h1 className="mt-5 text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
            Make a polished video from{" "}
            <span className="bg-gradient-to-r from-fuchsia-500 to-indigo-500 bg-clip-text text-transparent">
              clips in
            </span>{" "}
            minutes.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg text-gray-600 lg:mx-0">
            Upload your own videos and photos — or pool clips from everyone at the
            same event. Vantage lines them up by matching audio and auto-cuts between
            the steadiest, best-sounding angle at every moment. Like a live TV
            director. You hand over clips, Vantage hands back one finished video.
          </p>
          <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center lg:justify-start">
            <a
              href="/solo"
              className="w-full sm:w-auto rounded-full bg-gradient-to-r from-fuchsia-500 to-indigo-500 px-7 py-3.5 text-center text-base font-semibold text-white shadow-lg shadow-fuchsia-500/25 transition hover:opacity-90"
            >
              Make a solo video
            </a>
            <a
              href="/app/create"
              className="w-full sm:w-auto rounded-full border border-gray-300 px-7 py-3.5 text-center text-base font-semibold text-gray-700 transition hover:bg-gray-50"
            >
              Start a shared event
            </a>
            <a
              href="#how-it-works"
              className="w-full sm:w-auto rounded-full border border-gray-300 px-7 py-3.5 text-center text-base font-semibold text-gray-700 transition hover:bg-gray-50"
            >
              How it works
            </a>
          </div>
          <p className="mt-6 text-sm text-gray-400">
            Phone app · iOS &amp; Android · coming soon
          </p>
        </div>

        <PhoneMock />
      </div>
    </section>
  );
}

function PhoneMock() {
  return (
    <div className="mx-auto w-full max-w-[300px] select-none">
      <div className="relative rounded-[2.5rem] border-[10px] border-gray-900 bg-white shadow-2xl">
        <div className="h-2 w-24 rounded-b-2xl bg-gray-900 absolute left-1/2 top-0 -translate-x-1/2" />
        <div className="relative overflow-hidden rounded-[1.8rem] bg-gray-950 px-3 pb-5 pt-8">
          {/* timeline timeline */}
          <div className="flex items-center justify-between text-[10px] text-white/60">
            <span>Your event</span>
            <span>0:00</span>
          </div>
          <div className="mt-2 flex gap-1 rounded-xl bg-white/10 p-1.5">
            {["bg-rose-400", "bg-indigo-400", "bg-amber-400", "bg-emerald-400", "bg-fuchsia-400"].map(
              (c, i) => (
                <div key={i} className={`h-8 flex-1 rounded-md ${c} ${i === 2 ? "ring-2 ring-white" : "opacity-80"}`} />
              )
            )}
          </div>
          {/* video preview */}
          <div className="mt-3 aspect-[4/3] overflow-hidden rounded-xl bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-amber-400">
            <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-white">
              <VantageMark className="h-12 w-12 drop-shadow" />
              <div className="text-[11px] font-semibold">Auto-cut in progress</div>
              <div className="h-1 w-24 overflow-hidden rounded bg-white/30">
                <div className="h-full w-2/3 rounded bg-white" />
              </div>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-[9px] text-white/50">
            <span>Cam 3 · steady</span>
            <span>Best audio</span>
            <span>Face in frame</span>
          </div>
          <button className="mt-3 w-full rounded-full bg-white py-2 text-[11px] font-bold text-gray-900">
            Export finished video
          </button>
        </div>
      </div>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: "01",
      title: "Add your clips",
      body: "Upload your own videos and photos — or join a shared event timeline and drop in whatever you captured.",
    },
    {
      n: "02",
      title: "Vantage syncs them",
      body: "It matches every clip by audio, so shots from many people at the same moment line up perfectly in time.",
    },
    {
      n: "03",
      title: "Get one finished video",
      body: "Vantage auto-cuts between the steadiest, best-sounding, face-in-frame angle at every moment — handed back as one polished video.",
    },
  ];
  return (
    <section id="how-it-works" className="bg-gray-50 py-20 sm:py-24">
      <div className="mx-auto w-full max-w-6xl px-5">
        <p className="text-center text-sm font-semibold uppercase tracking-widest text-fuchsia-600">
          How it works
        </p>
        <h2 className="mx-auto mt-3 max-w-2xl text-center text-3xl font-bold tracking-tight sm:text-4xl">
          Like a live TV director, in your pocket
        </h2>
        <div className="mt-14 grid gap-8 sm:grid-cols-3">
          {steps.map((s) => (
            <div
              key={s.n}
              className="rounded-2xl border border-gray-200 bg-white p-7 shadow-sm"
            >
              <div className="text-sm font-bold text-fuchsia-500">{s.n}</div>
              <h3 className="mt-3 text-lg font-bold">{s.title}</h3>
              <p className="mt-2 text-gray-600">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Modes() {
  return (
    <section className="py-20 sm:py-24">
      <div className="mx-auto w-full max-w-6xl px-5">
        <p className="text-center text-sm font-semibold uppercase tracking-widest text-fuchsia-600">
          Two ways to record
        </p>
        <h2 className="mx-auto mt-3 max-w-2xl text-center text-3xl font-bold tracking-tight sm:text-4xl">
          Solo, or pool clips together
        </h2>
        <div className="mt-14 grid gap-8 md:grid-cols-2">
          <ModeCard
            badge="Solo"
            title="Just you, your phone"
            body="Shoot your own videos and photos and let Vantage turn the scattered footage into one clean, shareable video. Perfect for travel, vlogs, and day-to-day moments."
            icon="🎬"
          />
          <ModeCard
            badge="Collaborative events"
            title="Everyone contributes one timeline"
            body="Start an event pool and everyone adds their clips. Vantage merges audio, syncs angles, and picks the best shot of every moment — so a wedding, party, or group trip becomes an edit no single person could make."
            icon="🎉"
          />
        </div>
      </div>
    </section>
  );
}

function ModeCard({
  badge,
  title,
  body,
  icon,
}: {
  badge: string;
  title: string;
  body: string;
  icon: string;
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-gray-200 bg-gradient-to-b from-white to-fuchsia-50/40 p-8">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-fuchsia-100 text-2xl">
        {icon}
      </div>
      <span className="mt-5 inline-flex w-fit rounded-full bg-fuchsia-100 px-3 py-1 text-xs font-semibold text-fuchsia-700">
        {badge}
      </span>
      <h3 className="mt-3 text-xl font-bold">{title}</h3>
      <p className="mt-2 text-gray-600">{body}</p>
    </div>
  );
}

function Waitlist() {
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<WaitlistResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await signupForWaitlist({ data: { email } });
      setResult(res);
      if (res.ok) setSubmitted(true);
    } catch {
      setResult({
        ok: false,
        code: "server_error",
        message: "Sorry — something went wrong. Please try again.",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section
      id="waitlist"
      className="relative overflow-hidden bg-gray-950 py-20 text-white sm:py-24"
    >
      <div
        className="pointer-events-none absolute inset-0 -z-10"
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(60% 60% at 50% 100%, rgba(217,70,239,0.35) 0%, rgba(0,0,0,0) 70%)",
        }}
      />
      <div className="mx-auto w-full max-w-2xl px-5 text-center">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Get early access to Vantage
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-gray-400">
          Join the waitlist and be first in line when Vantage launches. No spam — just
          one email when it&apos;s your turn.
        </p>

        {submitted ? (
          <div className="mx-auto mt-9 max-w-md rounded-2xl border border-fuchsia-500/40 bg-fuchsia-500/10 p-7">
            <div className="text-3xl">🎉</div>
            <h3 className="mt-3 text-xl font-bold">You&apos;re on the list!</h3>
            <p className="mt-2 text-sm text-gray-300">
              {result?.ok && result.status === "already_waitlisted"
                ? "Looks like you were already on it. We'll be in touch soon."
                : "Thanks for signing up. We'll email you the moment early access opens."}
            </p>
          </div>
        ) : (
          <>
            <form
              onSubmit={handleSubmit}
              className="mx-auto mt-9 flex max-w-md flex-col gap-3 sm:flex-row"
            >
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
                className="w-full flex-1 rounded-full border border-white/15 bg-white/10 px-5 py-3.5 text-white placeholder:text-gray-400 focus:border-fuchsia-400 focus:outline-none"
              />
              <button
                type="submit"
                disabled={loading}
                className="rounded-full bg-gradient-to-r from-fuchsia-500 to-indigo-500 px-7 py-3.5 font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
              >
                {loading ? "Signing up…" : "Join waitlist"}
              </button>
            </form>

            {result && !result.ok && (
              <div
                className={`mx-auto mt-5 max-w-md rounded-xl px-4 py-3 text-sm ${
                  result.code === "db_not_configured"
                    ? "bg-amber-500/15 text-amber-200"
                    : "bg-red-500/15 text-red-200"
                }`}
              >
                {result.message}
                {result.code === "db_not_configured" && (
                  <div className="mt-2 text-xs text-amber-300/80">
                    Admin note: connect a database and save the connection string as
                    the <code className="font-mono">DATABASE_URL</code> secret to
                    persist signups.
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-gray-800 bg-gray-950 py-6 text-center text-sm text-gray-400">
      Built with{" "}
      <a
        href="https://cto.new"
        className="underline hover:text-gray-200"
      >
        cto.new
      </a>
    </footer>
  );
}
