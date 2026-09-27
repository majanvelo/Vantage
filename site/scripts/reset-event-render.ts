/** Reset the fixture event's render marker so the next UI "Make movie" is a FRESH render. */
import { Pool } from "pg";
const EID = "80567e10-cc64-47a7-b245-564bf61156cb";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const r = await pool.query(
  `update renders set status='error', finished_key=null, error=$2, updated_at=now()
   where event_id = $1 returning event_id, status`,
  [EID, "reset by engineer to verify a fresh UI-driven render after the seconds/ms fix"]
);
console.log("RESET", JSON.stringify(r.rows));
await pool.end();
