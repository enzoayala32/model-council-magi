/**
 * Static demo content shown only when the query matches DEFAULT_QUERY (see
 * `useDemoTables` in ResultsDashboard) — illustrates the Tribunal/agree-
 * disagree tables before a real run has happened. Not live data.
 */

export const agreeRows = [
  {
    finding: "Inflation cooled from the 2022 peak, but remained sticky because services and shelter were slow to normalize.",
    models: ["openai/gpt-oss-20b:free", "nvidia/nemotron-3-ultra-550b-a55b:free", "google/gemma-4-26b-a4b-it:free"],
    evidence: "Core services stayed elevated while goods disinflation faded.",
    source: "richmondfed +1",
  },
  {
    finding: "Tariffs and trade uncertainty raised expected goods prices more than they explained the whole inflation picture.",
    models: ["openai/gpt-oss-20b:free", "nvidia/nemotron-3-ultra-550b-a55b:free", "google/gemma-4-26b-a4b-it:free", "nvidia/nemotron-3-super-120b-a12b:free"],
    evidence: "Import-sensitive categories showed renewed pressure in 2025.",
    source: "deloitte +2",
  },
  {
    finding: "The labor market and wage growth kept services demand resilient, limiting how quickly inflation could return to target.",
    models: ["openai/gpt-oss-20b:free", "nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia/nemotron-3-super-120b-a12b:free"],
    evidence: "Services inflation tracked wage-sensitive categories.",
    source: "usafacts +2",
  },
];

export const disagreeRows = [
  {
    topic: "How much tariffs mattered",
    cells: {
      "openai/gpt-oss-20b:free": "Important second-half pressure, especially for goods and inflation expectations.",
      "nvidia/nemotron-3-ultra-550b-a55b:free": "Meaningful, but too narrow to explain services and shelter persistence.",
      "google/gemma-4-26b-a4b-it:free": "A relative-price shock that risked spilling into broader expectations.",
      "nvidia/nemotron-3-super-120b-a12b:free": "Politically salient, but overstated as the single cause.",
    },
    why: "The models separate direct tariff pass-through from broader inflation persistence differently.",
  },
  {
    topic: "Shelter’s role",
    cells: {
      "openai/gpt-oss-20b:free": "Lagged rent measures were still a major source of measured CPI pressure.",
      "nvidia/nemotron-3-ultra-550b-a55b:free": "Shelter explained stickiness, but real-time rents pointed toward slower future pressure.",
      "google/gemma-4-26b-a4b-it:free": "Housing supply constraints mattered more than short-run demand.",
      "nvidia/nemotron-3-super-120b-a12b:free": "Shelter was a measurement lag story as much as a fresh inflation story.",
    },
    why: "They weigh official CPI shelter lags against real-time rental data at different levels.",
  },
];

export const uniqueRows = [
  {
    id: "openai/gpt-oss-20b:free",
    finding: "Business inventory front-loading likely distorted 2025 goods prices before tariffs fully landed.",
    matters: "It explains why some price pressure appeared before consumers saw the full policy effect.",
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    finding: "Inflation expectations were a transmission channel, not just an outcome.",
    matters: "Expectations can make temporary shocks more persistent through pricing and wage negotiations.",
  },
  {
    id: "google/gemma-4-26b-a4b-it:free",
    finding: "The cleanest story is category-specific: goods, shelter, and services each had different drivers.",
    matters: "Policy interpretation changes if inflation is decomposed instead of treated as one blob.",
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    finding: "Public perception lagged headline disinflation because visible prices stayed high.",
    matters: "It clarifies why consumers felt inflation even when year-over-year rates looked better.",
  },
];

export const modelResponses: Record<string, string[]> = {
  "openai/gpt-oss-20b:free": [
    "The strongest explanation is a mixed-driver story: residual shelter inflation, services demand, and renewed goods pressure from trade policy.",
    "I would not attribute 2025 inflation to a single shock. Tariffs mattered most where import exposure was obvious, while shelter and wages explained persistence.",
    "Confidence is medium-high because the drivers point in the same direction across CPI components, Fed commentary, and private forecasts.",
  ],
  "nvidia/nemotron-3-ultra-550b-a55b:free": [
    "The main caution is that some 2025 inflation looked like policy pass-through while some was simply the slow unwinding of earlier housing and labor-market dynamics.",
    "Tariffs raise prices, but they do not automatically create durable inflation unless expectations, wages, or margins transmit the shock broadly.",
    "The most useful answer is therefore segmented: goods were tariff-sensitive, shelter was lag-sensitive, and services were wage-sensitive.",
  ],
  "google/gemma-4-26b-a4b-it:free": [
    "The models converge on three categories: shelter, services, and import-sensitive goods. Each category had a different timing pattern.",
    "The strongest evidence is cross-source: official CPI/PCE components, Fed regional analysis, and private-sector commentary about inventory behavior.",
    "For policy, the key distinction is temporary level effects versus persistent inflation momentum.",
  ],
  "nvidia/nemotron-3-super-120b-a12b:free": [
    "The obvious story is tariffs, but the better story is that tariffs landed on an economy where many prices had already reset upward.",
    "Consumers react to price levels, not just inflation rates. That gap explains why the political conversation sounded hotter than the headline data.",
    "The wildcard was whether firms absorbed margin pressure or passed it through quickly.",
  ],
};
