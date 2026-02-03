import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';

const SPACEX_API = 'https://api.spacexdata.com/v4';

const agent = await createAgent({
  name: 'spacex-data',
  version: '1.0.0',
  description: 'Real-time SpaceX launch data, rocket specs, and Starlink satellite tracking for AI agents. Free overview, paid deep data.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPER: Fetch real data ===
async function fetchJSON(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

// === FREE ENDPOINT: Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free SpaceX overview - latest launch, rocket count, company stats. Try before you buy.',
  input: z.object({}),
  handler: async () => {
    const [latestLaunch, rockets, launchpads] = await Promise.all([
      fetchJSON(`${SPACEX_API}/launches/latest`),
      fetchJSON(`${SPACEX_API}/rockets`),
      fetchJSON(`${SPACEX_API}/launchpads`),
    ]);

    return {
      output: {
        latestLaunch: {
          name: latestLaunch.name,
          date: latestLaunch.date_utc,
          success: latestLaunch.success,
          flightNumber: latestLaunch.flight_number,
        },
        stats: {
          totalRockets: rockets.length,
          activeRockets: rockets.filter((r: any) => r.active).length,
          totalLaunchpads: launchpads.length,
          activeLaunchpads: launchpads.filter((p: any) => p.status === 'active').length,
        },
        fetchedAt: new Date().toISOString(),
        dataSource: 'SpaceX API (live)',
      },
    };
  },
});

// === PAID $0.001: Launch Lookup ===
addEntrypoint({
  key: 'launch-lookup',
  description: 'Look up a specific SpaceX launch by name or ID',
  input: z.object({
    query: z.string().describe('Launch name (e.g. "Crew-5") or launch ID'),
  }),
  price: '0.001',
  handler: async (ctx) => {
    const allLaunches = await fetchJSON(`${SPACEX_API}/launches`);
    const query = ctx.input.query.toLowerCase();
    
    // Search by ID first, then by name
    const launch = allLaunches.find((l: any) => 
      l.id === ctx.input.query || 
      l.name.toLowerCase().includes(query)
    );

    if (!launch) {
      return { output: { found: false, message: `No launch found matching "${ctx.input.query}"` } };
    }

    return {
      output: {
        found: true,
        launch: {
          id: launch.id,
          name: launch.name,
          flightNumber: launch.flight_number,
          dateUtc: launch.date_utc,
          success: launch.success,
          upcoming: launch.upcoming,
          details: launch.details,
          rocket: launch.rocket,
          launchpad: launch.launchpad,
          links: {
            webcast: launch.links?.webcast,
            article: launch.links?.article,
            wikipedia: launch.links?.wikipedia,
            patch: launch.links?.patch?.small,
          },
          cores: launch.cores?.map((c: any) => ({
            coreId: c.core,
            flight: c.flight,
            reused: c.reused,
            landingSuccess: c.landing_success,
            landingType: c.landing_type,
          })),
        },
      },
    };
  },
});

// === PAID $0.002: Upcoming Launches ===
addEntrypoint({
  key: 'upcoming-launches',
  description: 'Get upcoming SpaceX launches with optional filtering',
  input: z.object({
    limit: z.number().optional().default(10).describe('Max launches to return'),
    rocketType: z.enum(['falcon9', 'falcon-heavy', 'starship', 'all']).optional().default('all'),
  }),
  price: '0.002',
  handler: async (ctx) => {
    const upcoming = await fetchJSON(`${SPACEX_API}/launches/upcoming`);
    
    let filtered = upcoming;
    if (ctx.input.rocketType !== 'all') {
      const rocketIds: Record<string, string> = {
        'falcon9': '5e9d0d95eda69973a809d1ec',
        'falcon-heavy': '5e9d0d95eda69974db09d1ed',
        'starship': '5e9d0d96eda699382d09d1ee',
      };
      const rocketId = rocketIds[ctx.input.rocketType];
      filtered = upcoming.filter((l: any) => l.rocket === rocketId);
    }

    const limited = filtered.slice(0, ctx.input.limit);

    return {
      output: {
        total: upcoming.length,
        filtered: filtered.length,
        returned: limited.length,
        launches: limited.map((l: any) => ({
          id: l.id,
          name: l.name,
          dateUtc: l.date_utc,
          datePrecision: l.date_precision,
          flightNumber: l.flight_number,
          rocket: l.rocket,
          launchpad: l.launchpad,
          webcast: l.links?.webcast,
        })),
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID $0.002: Rocket Specs ===
addEntrypoint({
  key: 'rockets',
  description: 'Get detailed rocket specifications by name or all rockets',
  input: z.object({
    name: z.string().optional().describe('Rocket name (e.g. "Falcon 9", "Falcon Heavy", "Starship") or omit for all'),
  }),
  price: '0.002',
  handler: async (ctx) => {
    const rockets = await fetchJSON(`${SPACEX_API}/rockets`);
    
    let result = rockets;
    if (ctx.input.name) {
      const query = ctx.input.name.toLowerCase();
      result = rockets.filter((r: any) => r.name.toLowerCase().includes(query));
    }

    return {
      output: {
        count: result.length,
        rockets: result.map((r: any) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          active: r.active,
          stages: r.stages,
          boosters: r.boosters,
          costPerLaunch: r.cost_per_launch,
          successRatePct: r.success_rate_pct,
          firstFlight: r.first_flight,
          height: r.height,
          diameter: r.diameter,
          mass: r.mass,
          payloadWeights: r.payload_weights,
          engines: {
            number: r.engines?.number,
            type: r.engines?.type,
            version: r.engines?.version,
            propellant1: r.engines?.propellant_1,
            propellant2: r.engines?.propellant_2,
          },
          description: r.description,
          wikipedia: r.wikipedia,
        })),
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID $0.003: Starlink Satellites ===
addEntrypoint({
  key: 'starlink',
  description: 'Get Starlink satellite constellation data with optional filtering',
  input: z.object({
    limit: z.number().optional().default(50).describe('Max satellites to return'),
    version: z.string().optional().describe('Filter by version (e.g. "v1.0", "v1.5")'),
  }),
  price: '0.003',
  handler: async (ctx) => {
    const starlinks = await fetchJSON(`${SPACEX_API}/starlink`);
    
    let filtered = starlinks;
    if (ctx.input.version) {
      filtered = starlinks.filter((s: any) => s.version === ctx.input.version);
    }

    // Get active (not decayed) satellites
    const active = filtered.filter((s: any) => !s.spaceTrack?.DECAYED);
    const limited = active.slice(0, ctx.input.limit);

    return {
      output: {
        totalConstellation: starlinks.length,
        totalActive: starlinks.filter((s: any) => !s.spaceTrack?.DECAYED).length,
        filtered: filtered.length,
        returned: limited.length,
        satellites: limited.map((s: any) => ({
          id: s.id,
          version: s.version,
          heightKm: s.height_km,
          latitude: s.latitude,
          longitude: s.longitude,
          velocityKms: s.velocity_kms,
          spaceTrack: {
            objectName: s.spaceTrack?.OBJECT_NAME,
            launchDate: s.spaceTrack?.LAUNCH_DATE,
            decayed: s.spaceTrack?.DECAYED,
            period: s.spaceTrack?.PERIOD,
            apoapsis: s.spaceTrack?.APOAPSIS,
            periapsis: s.spaceTrack?.PERIAPSIS,
          },
        })),
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID $0.005: Full Report ===
addEntrypoint({
  key: 'full-report',
  description: 'Comprehensive SpaceX report: all rockets, launchpads, recent launches, upcoming launches, and Starlink stats',
  input: z.object({
    recentLaunchCount: z.number().optional().default(5),
    upcomingLaunchCount: z.number().optional().default(5),
  }),
  price: '0.005',
  handler: async (ctx) => {
    const [rockets, launchpads, launches, upcoming, starlinks] = await Promise.all([
      fetchJSON(`${SPACEX_API}/rockets`),
      fetchJSON(`${SPACEX_API}/launchpads`),
      fetchJSON(`${SPACEX_API}/launches`),
      fetchJSON(`${SPACEX_API}/launches/upcoming`),
      fetchJSON(`${SPACEX_API}/starlink`),
    ]);

    // Get recent past launches (sorted by date desc)
    const pastLaunches = launches
      .filter((l: any) => !l.upcoming)
      .sort((a: any, b: any) => new Date(b.date_utc).getTime() - new Date(a.date_utc).getTime())
      .slice(0, ctx.input.recentLaunchCount);

    const upcomingLaunches = upcoming.slice(0, ctx.input.upcomingLaunchCount);

    const activeStarlinks = starlinks.filter((s: any) => !s.spaceTrack?.DECAYED);

    return {
      output: {
        summary: {
          totalLaunches: launches.length,
          successfulLaunches: launches.filter((l: any) => l.success === true).length,
          failedLaunches: launches.filter((l: any) => l.success === false).length,
          upcomingLaunches: upcoming.length,
          totalStarlinks: starlinks.length,
          activeStarlinks: activeStarlinks.length,
        },
        rockets: rockets.map((r: any) => ({
          name: r.name,
          active: r.active,
          successRatePct: r.success_rate_pct,
          costPerLaunch: r.cost_per_launch,
        })),
        launchpads: launchpads.map((p: any) => ({
          name: p.name,
          fullName: p.full_name,
          status: p.status,
          launchAttempts: p.launch_attempts,
          launchSuccesses: p.launch_successes,
          region: p.region,
        })),
        recentLaunches: pastLaunches.map((l: any) => ({
          name: l.name,
          date: l.date_utc,
          success: l.success,
          flightNumber: l.flight_number,
        })),
        upcomingLaunches: upcomingLaunches.map((l: any) => ({
          name: l.name,
          date: l.date_utc,
          datePrecision: l.date_precision,
          flightNumber: l.flight_number,
        })),
        generatedAt: new Date().toISOString(),
        dataSource: 'SpaceX API (live)',
      },
    };
  },
});

// === ANALYTICS ENDPOINTS (FREE) ===
addEntrypoint({
  key: 'analytics',
  description: 'Payment analytics summary',
  input: z.object({
    windowMs: z.number().optional().describe('Time window in ms'),
  }),
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { error: 'Analytics not available', payments: [] } };
    }
    const summary = await getSummary(tracker, ctx.input.windowMs);
    return {
      output: {
        ...summary,
        outgoingTotal: summary.outgoingTotal.toString(),
        incomingTotal: summary.incomingTotal.toString(),
        netTotal: summary.netTotal.toString(),
      },
    };
  },
});

addEntrypoint({
  key: 'analytics-transactions',
  description: 'Recent payment transactions',
  input: z.object({
    windowMs: z.number().optional(),
    limit: z.number().optional().default(50),
  }),
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { transactions: [] } };
    }
    const txs = await getAllTransactions(tracker, ctx.input.windowMs);
    return { output: { transactions: txs.slice(0, ctx.input.limit) } };
  },
});

addEntrypoint({
  key: 'analytics-csv',
  description: 'Export payment data as CSV',
  input: z.object({ windowMs: z.number().optional() }),
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { csv: '' } };
    }
    const csv = await exportToCSV(tracker, ctx.input.windowMs);
    return { output: { csv } };
  },
});

// === Icon endpoint ===
app.get('/icon.png', async (c) => {
  // Return a simple SVG icon as image
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0a0a1a"/>
      <stop offset="100%" style="stop-color:#1a1a3a"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="64" fill="url(#bg)"/>
  <path d="M256 80 L290 200 L290 350 L270 400 L242 400 L222 350 L222 200 Z" fill="#ffffff"/>
  <path d="M256 60 L280 120 L232 120 Z" fill="#ff6b35"/>
  <path d="M222 320 L180 400 L222 380 Z" fill="#ff6b35"/>
  <path d="M290 320 L332 400 L290 380 Z" fill="#ff6b35"/>
  <ellipse cx="256" cy="420" rx="25" ry="40" fill="#ff9500" opacity="0.9"/>
  <ellipse cx="256" cy="256" rx="180" ry="60" fill="none" stroke="#4dabf7" stroke-width="2" opacity="0.6" transform="rotate(-20 256 256)"/>
  <circle cx="100" cy="220" r="6" fill="#4dabf7"/>
  <circle cx="420" cy="280" r="6" fill="#4dabf7"/>
</svg>`;
  return new Response(svg, {
    headers: { 'Content-Type': 'image/svg+xml' }
  });
});

// === ERC-8004 Registration ===
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.BASE_URL || 'https://spacex-data-production.up.railway.app';
  return c.json({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'spacex-data',
    description: 'Real-time SpaceX launch data, rocket specs, and Starlink satellite tracking. 1 free + 5 paid endpoints via x402.',
    image: `${baseUrl}/icon.png`,
    services: [
      { name: 'web', endpoint: baseUrl },
      { name: 'A2A', endpoint: `${baseUrl}/.well-known/agent.json`, version: '0.3.0' },
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ['reputation'],
  });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`SpaceX Data Agent running on port ${port}`);

export default { port, fetch: app.fetch };
