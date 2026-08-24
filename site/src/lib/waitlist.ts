import { createServerFn } from "@tanstack/react-start";
import { getPool, query } from "~/db";

export type WaitlistResult =
  | { ok: true; status: "waitlisted" | "already_waitlisted" }
  | { ok: false; code: "invalid_email"; message: string }
  | { ok: false; code: "db_not_configured"; message: string }
  | { ok: false; code: "server_error"; message: string };

export const signupForWaitlist = createServerFn({ method: "POST" }).handler(
  async ({ data }: { data: { email?: unknown } }): Promise<WaitlistResult> => {
    const email = typeof data?.email === "string" ? data.email.trim().toLowerCase() : "";

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return {
        ok: false,
        code: "invalid_email",
        message: "Please enter a valid email address.",
      };
    }

    try {
      getPool();
    } catch {
      return {
        ok: false,
        code: "db_not_configured",
        message:
          "Your email has been noted, but the waitlist database isn't connected yet. Signups will persist once DATABASE_URL is set.",
      };
    }

    try {
      await query(`
        create table if not exists waitlist_signups (
          id bigserial primary key,
          email text not null unique,
          created_at timestamptz not null default now()
        )
      `);

      const inserted = await query<{ id: string }>(
        `insert into waitlist_signups (email) values ($1)
         on conflict (email) do nothing
         returning id`,
        [email]
      );

      return {
        ok: true,
        status: inserted.length > 0 ? "waitlisted" : "already_waitlisted",
      };
    } catch (err) {
      console.error("waitlist signup failed:", err);
      return {
        ok: false,
        code: "server_error",
        message: "Sorry — we hit an error saving your email. Please try again.",
      };
    }
  }
);
