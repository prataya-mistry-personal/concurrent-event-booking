/**
 * Concurrency load test and invariant gate.
 *
 * Fires N simultaneous hold requests at a single seat, then attempts checkout for
 * every hold that was accepted, and finally asserts the invariants that matter.
 * Exits non-zero when an expectation for the chosen mode is violated, so it works
 * as a CI check and not just as a demo.
 *
 *   npm run loadtest -- --concurrency 200 --mode safe
 *   npm run loadtest -- --concurrency 200 --mode naive
 *
 * Note on the database pool: DATABASE_URL sets connection_limit=25. With Prisma's
 * default pool the requests would queue inside the client and the contention
 * being measured would largely disappear.
 */

type Mode = 'safe' | 'naive';

interface Options {
  url: string;
  eventId: string | null;
  seatId: number | null;
  concurrency: number;
  mode: Mode;
}

interface Timed {
  status: number;
  ms: number;
  body: any;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    url: 'http://localhost:3000',
    eventId: null,
    seatId: null,
    concurrency: 200,
    mode: 'safe',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };

    switch (arg) {
      case '--url':
        options.url = next().replace(/\/$/, '');
        break;
      case '--event':
        options.eventId = next();
        break;
      case '--seat':
        options.seatId = Number(next());
        break;
      case '--concurrency':
      case '-c':
        options.concurrency = Number(next());
        break;
      case '--mode':
      case '-m': {
        const mode = next();
        if (mode !== 'safe' && mode !== 'naive') {
          throw new Error(`--mode must be "safe" or "naive", got "${mode}"`);
        }
        options.mode = mode;
        break;
      }
      case '--help':
      case '-h':
        console.log(
          'Usage: npm run loadtest -- [--url URL] [--event ID] [--seat ID] [--concurrency N] [--mode safe|naive]'
        );
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }

  return options;
}

async function timedPost(url: string, body: unknown): Promise<Timed> {
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, ms: performance.now() - started, body: parsed };
  } catch (error) {
    // A transport failure is a result too; recording it as 0 keeps the histogram
    // honest instead of aborting the whole run.
    return { status: 0, ms: performance.now() - started, body: String(error) };
  }
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed with ${res.status}`);
  return res.json();
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function histogram(results: Timed[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const result of results) {
    counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
  }
  return new Map([...counts.entries()].sort((a, b) => a[0] - b[0]));
}

function reportPhase(name: string, results: Timed[]): void {
  console.log(`\n${name}`);

  if (results.length === 0) {
    console.log('  (no requests)');
    return;
  }

  for (const [status, count] of histogram(results)) {
    const label = status === 0 ? 'transport error' : String(status);
    console.log(`  status ${label.padStart(15)} -> ${String(count).padStart(5)}`);
  }

  const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
  const fmt = (n: number) => `${n.toFixed(1)}ms`;
  console.log(
    `  latency  p50 ${fmt(percentile(sorted, 50))}   p95 ${fmt(percentile(sorted, 95))}` +
      `   p99 ${fmt(percentile(sorted, 99))}   max ${fmt(sorted[sorted.length - 1])}`
  );
}

interface Check {
  label: string;
  actual: string;
  expectation: string;
  ok: boolean;
}

function reportChecks(checks: Check[]): boolean {
  console.log('\nINVARIANTS');
  let allOk = true;
  for (const check of checks) {
    if (!check.ok) allOk = false;
    console.log(
      `  ${check.label.padEnd(34)} ${check.actual.padEnd(10)} ${check.expectation.padEnd(28)} ${
        check.ok ? 'OK' : 'VIOLATED'
      }`
    );
  }
  return allOk;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // Resolve the event and seat if they were not supplied.
  const events = await getJson(`${options.url}/events`);
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('No events found. Run `npm run seed` first.');
  }

  const eventId = options.eventId ?? events[0].id;
  const seats = await getJson(`${options.url}/events/${eventId}/seats`);

  const seat =
    options.seatId !== null
      ? seats.find((s: any) => s.id === options.seatId)
      : seats.find((s: any) => s.status === 'AVAILABLE');

  if (!seat) {
    throw new Error(
      options.seatId !== null
        ? `Seat ${options.seatId} not found in event ${eventId}`
        : `No AVAILABLE seat in event ${eventId}. Reset the database and re-seed.`
    );
  }

  const holdPath = options.mode === 'safe' ? '/bookings/hold' : '/bookings/hold-naive';
  const checkoutPath = options.mode === 'safe' ? '/bookings/checkout' : '/bookings/checkout-naive';

  console.log('Event Booking load test');
  console.log(`  target        ${options.url}`);
  console.log(`  mode          ${options.mode}`);
  console.log(`  event         ${eventId}`);
  console.log(`  seat          ${seat.id} (${seat.label}) starting as ${seat.status}`);
  console.log(`  concurrency   ${options.concurrency}`);

  // Warm up so connection setup does not distort the first request's latency.
  await getJson(`${options.url}/health`);

  const users = Array.from({ length: options.concurrency }, (_, i) => `load-user-${i}`);

  // Open and keep alive one connection per virtual user *before* the storm.
  // Without this, establishing N sockets takes longer than the race window
  // itself, so the requests arrive staggered and the contention being measured
  // never actually happens.
  await Promise.all(
    users.map(() => fetch(`${options.url}/health`).then((r) => r.text()))
  );

  // Build every request before awaiting any, so they are genuinely in flight
  // together rather than pipelined.
  const holdResults = await Promise.all(
    users.map((userId) =>
      timedPost(`${options.url}${holdPath}`, { userId, eventId, seatId: seat.id })
    )
  );
  reportPhase('HOLD phase', holdResults);

  const accepted = holdResults.filter((r) => r.status === 201 && r.body?.booking?.id);
  console.log(`  accepted holds: ${accepted.length}`);

  const checkoutResults = await Promise.all(
    accepted.map((hold) =>
      timedPost(`${options.url}${checkoutPath}`, {
        bookingId: hold.body.booking.id,
        userId: hold.body.booking.user_id,
      })
    )
  );
  reportPhase('CHECKOUT phase', checkoutResults);

  // Read the authoritative outcome back from the API rather than trusting the
  // response codes we happened to observe.
  const finalBookings = await Promise.all(
    accepted.map((hold) => getJson(`${options.url}/bookings/${hold.body.booking.id}`))
  );
  const confirmedForSeat = finalBookings.filter((b) => b.status === 'CONFIRMED').length;

  const stats = await getJson(`${options.url}/events/${eventId}/stats`);
  const finalSeats = await getJson(`${options.url}/events/${eventId}/seats`);
  const finalSeat = finalSeats.find((s: any) => s.id === seat.id);

  const checks: Check[] =
    options.mode === 'safe'
      ? [
          {
            label: 'holds accepted for one seat',
            actual: String(accepted.length),
            expectation: 'exactly 1',
            ok: accepted.length === 1,
          },
          {
            label: 'confirmed bookings for seat',
            actual: String(confirmedForSeat),
            expectation: 'exactly 1',
            ok: confirmedForSeat === 1,
          },
          {
            label: 'seat final status',
            actual: String(finalSeat?.status),
            expectation: 'BOOKED',
            ok: finalSeat?.status === 'BOOKED',
          },
          {
            label: 'duplicate live holds (event)',
            actual: String(stats.duplicate_pending_seats),
            expectation: '0',
            ok: stats.duplicate_pending_seats === 0,
          },
          {
            label: 'oversold seats (event)',
            actual: String(stats.oversold_seats),
            expectation: '0',
            ok: stats.oversold_seats === 0,
          },
        ]
      : [
          {
            label: 'holds accepted for one seat',
            actual: String(accepted.length),
            expectation: 'more than 1 (the bug)',
            ok: accepted.length > 1,
          },
          {
            label: 'duplicate live holds (event)',
            actual: String(stats.duplicate_pending_seats),
            expectation: '1 (the bug)',
            ok: stats.duplicate_pending_seats >= 1,
          },
          {
            label: 'confirmed bookings for seat',
            actual: String(confirmedForSeat),
            expectation: 'at most 1 (index holds)',
            ok: confirmedForSeat <= 1,
          },
          {
            label: 'oversold seats (event)',
            actual: String(stats.oversold_seats),
            expectation: '0 (index holds)',
            ok: stats.oversold_seats === 0,
          },
        ];

  const passed = reportChecks(checks);

  if (options.mode === 'naive') {
    console.log(
      `\n  ${accepted.length} users were told they held seat ${seat.id}. ` +
        `${Math.max(0, accepted.length - confirmedForSeat)} of them were wrong.`
    );
  }

  console.log(`\nRESULT: ${passed ? 'PASS' : 'FAIL'}`);
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nload test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
