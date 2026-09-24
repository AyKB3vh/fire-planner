/**
 * Estonian Household FIRE & Withdrawal Planner — v2.4 domain types.
 * Layer 1 of the architecture. No logic lives here beyond trivial type helpers.
 *
 * Money convention: all monetary values are EUR (euros, nominal unless a
 * field explicitly says "todayEUR"). Flow application points round to cents
 * (see engine/money.ts) to avoid uncontrolled floating-point drift.
 */

export const SCHEMA_VERSION = '2.4.0';
export const BASE_YEAR = 2026;

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export type Provenance = 'actual' | 'projected' | 'estimated' | 'userAssumed';
export type RuleStatus = 'verified' | 'secondary' | 'unverified' | 'userAssumed';
export type RemunerationType = 'employment' | 'boardMemberFee';
export type FundingRule = 'LoanFirst' | 'DistributionFirst';
export type RepaymentSolvencyRule = 'none' | 'blockIfEquityNegative';
export type BucketKey =
  | 'personalCash'
  | 'ouCash'
  | 'ouInvestments'
  | 'shareholderLoan'
  | 'iiPillar'
  | 'iiiPillar';

export const BUCKET_KEYS: BucketKey[] = [
  'personalCash',
  'ouCash',
  'ouInvestments',
  'shareholderLoan',
  'iiPillar',
  'iiiPillar',
];

/* ------------------------------------------------------------------ */
/* Household                                                           */
/* ------------------------------------------------------------------ */

export interface Adult {
  id: string;
  name: string;
  birthYear: number;
  /** 1..12; unknown/absent follows the documented January–June rule. */
  birthMonth?: number;
  statePensionEnabled: boolean;
  healthcareRequired: boolean;
  /** User override for projected pension age. */
  pensionAgeOverride?: number;
  /** State pension monthly amount in today's euros; undefined = default assumption. */
  statePensionTodayEUR?: number;
  remunerationType: RemunerationType;
  /** Whether a role/work arrangement is recorded for remuneration substance. */
  workRoleRecorded: boolean;
  /** Include voluntary Tervisekassa insurance when no other route is active. */
  voluntaryHealthcare: boolean;
  /** Explicitly allow going without insurance (only meaningful if healthcareRequired. */
  allowNoInsurance: boolean;
}

export interface Household {
  id: string;
  name: string;
  adults: Adult[]; // 1 or 2
}

/* ------------------------------------------------------------------ */
/* Starting state                                                      */
/* ------------------------------------------------------------------ */

export interface Balances {
  personalCash: number;
  ouCash: number;
  ouInvestments: number;
  shareholderLoan: number;
  iiPillar: number;
  iiiPillar: number;
}

export interface StartingBalanceSheet extends Balances {
  provenance: Record<BucketKey, Provenance>;
}

export interface WithdrawalStartState {
  /** Must be 01-01 of a calendar year (annual model). */
  withdrawalStartDate: string; // 'YYYY-01-01'
  /** Date the starting balances refer to (normally 31 Dec of previous year). */
  startingBalancesAsOf: string; // 'YYYY-MM-DD'
  balances: StartingBalanceSheet;
  minimumCashReserve: number;
}

/* ------------------------------------------------------------------ */
/* Assumptions                                                         */
/* ------------------------------------------------------------------ */

export interface ReturnAssumption {
  /** Expected geometric return g: 1+g is the median annual growth factor. */
  geometricReturn: number;
  /** Annual log-return volatility (NOT the stdev of simple returns). */
  logVolatility: number;
}

export interface RangeMultiplier {
  fromYear: number; // absolute calendar year (inclusive)
  toYear: number; // inclusive
  multiplier: number;
}

export interface OneOffExpense {
  year: number;
  amount: number; // nominal EUR in that year
}

export interface SpendingAssumptions {
  /** Target annual household spending in today's euros. */
  targetAnnualTodayEUR: number;
  multipliers: RangeMultiplier[];
  oneOffs: OneOffExpense[];
  /** If true, voluntary healthcare premiums are already inside the spending input. */
  premiumsIncludedInSpending: boolean;
}

export interface StochasticInflationSettings {
  enabled: boolean;
  mean: number;
  volatility: number;
  persistence: number;
  /** Correlation with the common equity factor. */
  correlation: number;
}

export interface ReturnModelSettings {
  ou: ReturnAssumption;
  ii: ReturnAssumption;
  iii: ReturnAssumption;
  cashRate: number;
  /** Correlation among equity-like assets (equicorrelation) — default 0.95. */
  correlation: number;
  /** Optional explicit return floor (simple return); null = none. */
  returnFloor: number | null;
  stochasticInflation: StochasticInflationSettings;
}

export interface Assumptions {
  generalInflation: number;
  spendingInflation: number;
  healthcareInflation: number;
  spending: SpendingAssumptions;
  returns: ReturnModelSettings;
  /** Voluntary Tervisekassa premium, monthly, today's euros. */
  voluntaryPremiumTodayEUR: number;
  /** State pension monthly amount (today's euros) per adult id; fallback below. */
  statePensionTodayEUR: number;
  statePensionIndexation: number;
  /** Default (reinvestment share of surplus). */
  reinvestmentPct: number;
  /** Consumption valuation rate for ranked wealth; default = OÜ geometric return. */
  consumptionValuationRate: number;
  /** PV discount rate for lifetime tax; default = OÜ geometric return. */
  pvDiscountRate: number;
  /** Maximum defensible monthly gross remuneration per adult. */
  maxRemunerationPerAdult: number;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export interface EngineSettings {
  reserveUsableAsLastResort: boolean;
  repaymentSolvencyRule: RepaymentSolvencyRule;
  includeDistributionFirst: boolean;
  /** Distributable equity includes unrealised gains (assumption; accountant). */
  distributableEquityIncludesUnrealisedGains: boolean;
  /** Default II contribution rate from remuneration (0% per spec). */
  iiContributionRate: number;
  /** Search remuneration type in advanced mode (off by default). */
  searchRemunerationType: boolean;
}

export interface MonteCarloSettings {
  screen1Paths: number; // 100
  screen2Paths: number; // 400
  quickPaths: number; // 1000
  defaultPaths: number; // 5000
  highPrecisionPaths: number; // 20000
  seed: number; // 42
  screenFailureMargin1: number; // 3
  screenFailureMargin2: number; // 3
  stage2AWealthKeep: number; // 10
  stage2BWealthKeep: number; // 30
  stage2BFailureKeep: number; // 10
  targetSuccessProbability: number; // 0.95
  certifiedMode: boolean; // false
  precision: 'quick' | 'default' | 'high'; // 'default'
  /** Optional config: require zero reserve breaches for MC success. */
  requireNoReserveBreach: boolean;
}

export interface OptimisationSettings {
  tieWealthTolerance: number; // 0.001 (0.1%)
  robustTieProbability: number; // 0.001 (0.1 pp)
  lowestTaxWealthFloor: number; // 0.95
  simplestWealthFloor: number; // 0.97
  pillarDelayMin: number; // 0
  pillarDelayMax: number; // 5
  bufferCandidates: number[]; // [0,6,12,24]
  refinementIterations: number; // default 2
  /** Cap on stage-0 candidates (safety valve; null = no cap). */
  maxStage0Candidates: number | null;
}

/* ------------------------------------------------------------------ */
/* Policy                                                              */
/* ------------------------------------------------------------------ */

export interface Policy {
  id: string;
  /** Phase start years; first entry must equal the withdrawal start year. */
  phaseStartYears: number[];
  /** Monthly gross remuneration per phase, keyed by adult id. */
  remunerationByPhase: Record<string, number[]>; // adultId -> per phase
  iiStartDelay: number;
  iiiStartDelay: number;
  bufferMonths: number;
  fundingRule: FundingRule;
  /** Remuneration legal type per adult (user input; searched only in advanced mode). */
  remunerationTypes: Record<string, RemunerationType>;
  label?: string;
}

/* ------------------------------------------------------------------ */
/* Rule registry                                                       */
/* ------------------------------------------------------------------ */

export interface RuleEntry {
  id: string;
  label: string;
  year: number;
  value: number;
  unit: string;
  source: string;
  retrieved: string; // ISO date
  status: RuleStatus;
  extrapolation: 'constant' | 'inflation' | 'healthcareInflation' | 'cohort' | 'heldTable';
  notes?: string;
}

export type RuleRegistry = Record<string, RuleEntry>; // keyed `${id}@${year}` latest wins by getRule

/* ------------------------------------------------------------------ */
/* Actuals ledger                                                      */
/* ------------------------------------------------------------------ */

export interface ActualYearEntry {
  year: number;
  personalCash?: number;
  ouCash?: number;
  ouInvestments?: number;
  shareholderLoan?: number;
  iiPillar?: number;
  iiiPillar?: number;
  spending?: number;
  provenance: Provenance;
}

export type ActualLedger = Record<number, ActualYearEntry>;

/* ------------------------------------------------------------------ */
/* Projection results                                                  */
/* ------------------------------------------------------------------ */

export interface TaxResult {
  year: number;
  /** Per-adult personal income tax. */
  pitByAdult: Record<string, number>;
  employeeUI: number;
  employerSocialTax: number;
  employerUI: number;
  employeeII: number;
  distributionTax: number;
  /** total personal income tax (PIT) across adults. */
  totalPIT: number;
  /** personal taxes + personal charges (PIT + employee UI). */
  personalTaxes: number;
  /** company-side charges (social tax + employer UI) — OÜ outflows. */
  companyCharges: number;
  /** total = PIT + employeeUI + employerSocialTax + employerUI + distributionTax. */
  total: number;
  /** rule ids used, for provenance. */
  ruleIds: string[];
}

export interface HealthcareCoverageMonth {
  adultId: string;
  month: number; // 1..12
  route: HealthcareRoute;
  funded: boolean;
}

export type HealthcareRoute =
  | 'statePensioner'
  | 'remuneration'
  | 'voluntary'
  | 'none';

export interface HealthcareResult {
  year: number;
  premiumPaid: number;
  coverageFailure: boolean;
  uncoveredAdults: string[];
  perAdult: Record<string, { route: HealthcareRoute; coveredMonths: number; premium: number }>;
}

export interface FailureFlags {
  spendingShortfall: boolean;
  coverageFailure: boolean;
  reserveBreach: boolean;
  ouInsolvency: boolean;
}

export interface FlowBreakdown {
  statePensionGross: number;
  statePensionNet: number;
  pillarIIIPayment: number;
  pillarIIPayment: number;
  remunerationGross: number; // annual gross across adults
  remunerationNet: number;
  employerCost: number; // OÜ payroll outflow (gross + company charges)
  healthcarePremium: number;
  personalCashUsedAboveReserve: number;
  emergencyReserveUsed: number;
  loanRepayment: number;
  distributionNet: number;
  distributionTax: number;
  ouInvestmentSales: number; // total sold inside OÜ for any reason
  ouCashFromInvestments: number; // buffer reallocation investments -> cash
  ouCashToInvestments: number; // buffer reallocation cash -> investments
  reinvestment: number; // new shareholder loan
  extraSpending: number;
  targetSpending: number;
  spendingShortfall: number;
  taxes: TaxResult;
}

export interface YearResult {
  year: number;
  ageOlder: number;
  ageYounger: number;
  // start-of-year balances (after actual overrides)
  start: Balances;
  // end-of-year balances
  end: Balances;
  ouEquityStart: number;
  ouEquityEnd: number;
  netWorthEnd: number;
  nominalSpending: number; // target spending (inflated) for the year
  realisedSpending: number; // target + extra spending actually funded
  extraSpending: number;
  healthPremium: number;
  inflows: FlowBreakdown;
  taxes: TaxResult;
  healthcare: HealthcareResult;
  failures: FailureFlags;
  investmentReturns: {
    ou: number;
    ii: number;
    iii: number;
    cash: number;
    total: number;
  };
  latentTax: number;
  healthcareCost: number;
  minCashDuringYear: number;
  /** per-adult remuneration monthly gross this year */
  remunerationMonthly: Record<string, number>;
  /** state pension monthly nominal this year */
  statePensionMonthly: Record<string, number>;
  phases: { startYear: number; label: string }[];
  /** Explicit actual-vs-projected variance line when actuals override the projection. */
  revaluationVariance: number;
}

export interface PolicyResult {
  policyId: string;
  years: YearResult[];
  feasible: boolean; // deterministic: no spending shortfall & no coverage failure
  anyReserveBreach: boolean;
  ouInsolvencyAnyYear: boolean;
  terminalWealth: number; // household net worth at horizon end (face value)
  rankedWealth: number; // terminal + valued extra spending
  lifetimeTaxNominal: number;
  lifetimeTaxTodayEUR: number;
  lifetimeTaxPV: number;
  lifetimeTaxPersonal: number;
  lifetimeTaxCompany: number;
  lifetimeHealthcareCost: number;
  totalExtraSpending: number;
  firstShortfallYear: number | null;
  firstCoverageFailureYear: number | null;
  firstReserveBreachYear: number | null;
  firstLiquidDepletionYear: number | null;
  firstTotalDepletionYear: number | null;
  minOUEquity: number;
  totalSpending: number; // target + extra, funded
  failureYears: number[];
}

/* ------------------------------------------------------------------ */
/* Monte Carlo                                                          */
/* ------------------------------------------------------------------ */

export type FailureKind =
  | 'spendingShortfall'
  | 'coverageFailure'
  | 'reserveBreach'
  | 'liquidDepletion'
  | 'totalDepletion'
  | 'ouInsolvency';

export interface PathOutcome {
  success: boolean;
  reserveBreach: boolean;
  firstFailureYear: number | null;
  firstShortfallYear: number | null;
  firstCoverageFailureYear: number | null;
  firstReserveBreachYear: number | null;
  firstLiquidDepletionYear: number | null;
  firstTotalDepletionYear: number | null;
  terminalWealth: number;
  rankedWealth: number;
  lifetimeTax: number;
  extraSpending: number;
  minOUEquity: number;
}

export interface WilsonInterval {
  p: number;
  lower: number;
  upper: number;
  n: number;
}

export interface MCDistribution {
  n: number;
  successes: number;
  /** modelled success probability p̂ */
  successProbability: number;
  wilson: WilsonInterval;
  spendingShortfallProbability: number;
  coverageFailureProbability: number;
  reserveBreachProbability: number;
  liquidDepletionProbability: number;
  totalDepletionProbability: number;
  ouInsolvencyProbability: number;
  terminalWealth: { median: number; p5: number; p95: number };
  rankedWealthMedian: number;
  lifetimeTax: { median: number; p5: number; p95: number };
  extraSpending: { median: number; p5: number; p95: number };
  firstFailureYearHistogram: { year: number; count: number }[];
  firstDepletionYearHistogram: { year: number; count: number }[];
}

/* ------------------------------------------------------------------ */
/* Optimiser                                                           */
/* ------------------------------------------------------------------ */

export type StageId = 'stage0' | 'stage1' | 'stage2a' | 'stage2b' | 'stage3' | 'stage4';

export interface StageCandidateRecord {
  candidateId: string;
  stage: StageId;
  survived: boolean;
  reason: string;
  failures?: number;
  successProbability?: number;
  rankedWealth?: number;
}

export interface CandidateResult {
  candidateId: string;
  policy: Policy;
  /** Deterministic diagnostics (Stage 1) — never used for probabilistic pruning. */
  diagnostics: {
    central: { terminalWealth: number; feasible: boolean };
    firstYearCrash: { terminalWealth: number; feasible: boolean };
    lostDecade: { terminalWealth: number; feasible: boolean };
    highInflation: { terminalWealth: number; feasible: boolean } | null;
  } | null;
  screen1?: MCDistribution;
  screen2?: MCDistribution;
  full?: MCDistribution;
  passes: boolean;
  removedAtStage: StageId | null;
  removalReason: string | null;
}

export interface StrategyVariant {
  variant: 'recommended' | 'lowestTax' | 'mostRobust' | 'simplest';
  candidateId: string | null;
  policy: Policy | null;
  reason: string;
  rankedWealth: number | null;
  successProbability: number | null;
  pvLifetimeTax: number | null;
}

export interface StressTestResult {
  id: string;
  label: string;
  terminalWealth: number;
  feasible: boolean;
  detail?: string;
}

export interface OptimisationResult {
  inputHash: string;
  createdAt: string;
  target: number;
  certified: boolean;
  seed: number;
  pathsUsed: number;
  horizon: { startYear: number; endYear: number };
  validated: StartingStateValidation;
  stageRecords: StageCandidateRecord[];
  candidates: CandidateResult[];
  variants: {
    recommended: StrategyVariant;
    lowestTax: StrategyVariant;
    mostRobust: StrategyVariant;
    simplest: StrategyVariant;
  };
  /** true when no policy passed the target. */
  noPass: boolean;
  bestObservedSuccess: number;
  dominantFailure: { kind: string; count: number; medianFirstYear: number | null } | null;
  stressTests: StressTestResult[];
  warnings: string[];
  durationMs: number;
  cancelled: boolean;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface StartingStateValidation {
  ok: boolean;
  issues: ValidationIssue[];
}

/* ------------------------------------------------------------------ */
/* Scenario & persistence                                              */
/* ------------------------------------------------------------------ */

export interface Scenario {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  household: Household;
  startState: WithdrawalStartState;
  assumptions: Assumptions;
  engineSettings: EngineSettings;
  optimisationSettings: OptimisationSettings;
  monteCarloSettings: MonteCarloSettings;
  actuals: ActualLedger;
  /** Pillar access overrides. */
  pillarOverrides: PillarOverrides;
}

export interface PillarOverrides {
  /** null = use derived access year. */
  iiAccessYear: number | null;
  iiiAccessYear: number | null;
  /** Whether the 0%-tax long-term route is available inside the five-year early
   *  II window (Gate G1 item 1). If false, II access is at pension age. */
  iiEarlyWindowAssumedAvailable: boolean;
  /** Override recommended durations (years); null = table. */
  iiTermOverride: number | null;
  iiiTermOverride: number | null;
  iiTermTable: Record<number, number>; // age -> years (working values)
}

export interface ExportBundle {
  schemaVersion: string;
  exportedAt: string;
  activeScenarioId: string | null;
  scenarios: Scenario[];
  results: Record<string, OptimisationResult>;
}
