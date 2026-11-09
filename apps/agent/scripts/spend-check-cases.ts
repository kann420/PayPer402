/**
 * Labelled cases for the decision-layer evaluation. Labels and
 * their reasons were written before any evaluation run, and are never changed to fit results.
 *
 * The data is frozen so the file is stable across days: quotes at FIXED_AT_MS, articles with a
 * fixed publishedAt, newsroom URLs on http://localhost:4021, and seller summaries and translations
 * captured once from the real seller AI (see SELLER_TEXTS).
 */
import { ARTICLES, DEMO_SOURCE, SERVICES, quoteAt } from '@payper402/demo-seller';
import type { Label } from '../src/eval-policy';
import { resultExcerpt, type SpendCheckInput } from '../src/spend-check';

export const FIXED_AT_MS = Date.UTC(2026, 9, 16, 12, 0, 0);
const PUBLISHED_AT = '2026-10-16';
const ORIGIN = 'http://localhost:4021';
/** The default demo task (apps/agent/src/config.ts DEFAULT_TASK). */
export const DEMO_TASK = "Brief me on today's coffee market: current price, top news, and a summary in Vietnamese.";

type Params = Record<string, string | number>;
type Sym = 'KC' | 'CC' | 'SB' | 'CT';

export interface EvalCase {
  id: string;
  label: Label;
  holdout: boolean;
  /** Why the case has its label, written before any run. */
  why: string;
  task: string;
  call: { serviceId: string; params: Params };
  earlier: { serviceId: string; params: Params; data: unknown }[];
}

/** A fixed English paragraph given in the translate tasks. Fictional. */
const PARAGRAPH =
  'Coffee futures held near their recent range this week. Traders are watching the weather in the main growing regions and the pace of shipments from the ports. Roasters say retail demand is steady, but they are buying only for the next few months.';

/**
 * Seller AI output, captured once on 2026-10-16 with createClaudeSellerAi(new Anthropic(),
 * 'claude-sonnet-5-5'): one summarize per article (maxWords 120) and one translate per text.
 */
const SELLER_TEXTS = {
  rainsSummary:
    'Late rains in the main arabica highlands have slowed the start of the coffee harvest. Wet weather kept cherries on the trees longer and made steep slopes difficult to work, delaying first deliveries to local mills by about ten days. Cooperative managers said early lots show good quality, with dense beans and few defects, but volumes are below last season at this point. Traders said the delay helped keep futures prices firm despite cooling demand from roasters. Exporters have adjusted next month\'s shipping schedules, and some contracts may be filled from warehouse stocks. Forecasters expect drier weather next week, which could speed picking. Analysts said that if so, the shortfall might be made up before quarter\'s end, easing pressure on nearby contracts.',
  sugarCaneSummary:
    "Mills in the largest sugar cane region crushed more cane than analysts forecast over the past two weeks, aided by dry weather that kept harvesters working. An industry body said the share of cane going to sugar rather than ethanol remained high because sugar is currently more profitable than fuel, which should increase raw sugar available for export later in the year. Analysts cited the strong crush as the main reason raw sugar futures fell this week. Agronomists cautioned that continued dryness into the planting season could harm next year's cane. Mill managers reported slightly lower sugar content than last year, a typical result of a fast harvest. Shipping data showed many vessels queued at major ports, indicating continued buying from Asia and Africa.",
  cocoaMidCropSummary:
    "Farmers in West Africa's main cocoa-growing belt report that a month of steady rainfall has improved prospects for the mid-crop, harvested in the season's second half. A growers association's field surveys found more flowers and young pods on trees than at this point last year, and buyers at regional collection points said early arrivals were of good size. Agronomists warned the crop still needs dry, sunny periods to ripen, and that heavy rain can spread black pod disease. The improvement follows two poor harvests that drove cocoa prices to record highs and led chocolate makers to raise prices. Analysts said a better mid-crop won't end the supply deficit alone but could slow the drawdown of warehouse stocks. Futures dipped slightly as some speculators took profits.",
  cottonPlantingSummary:
    'Early surveys indicate farmers in several major growing regions plan to plant less cotton next season, favoring grain and oilseeds that have delivered better returns. Extension agents said growers are concerned about fertilizer and fuel costs, and cotton requires more inputs per acre than some competing crops. A farm economist noted that, with normal weather, lower acreage could reduce output and eventually support prices. For now, the market remains focused on large carry-over stocks from the current season. Spinning mills reported uneven yarn demand, with strong orders for basic fabrics but weaker ones for fashion items. Merchants said mills in Asia that previously bought from other origins are showing more interest. Cotton futures were little changed on the survey as traders await official planting figures in the spring.',
  roastersSummary:
    'Several mid-sized coffee roasters are reducing purchases for later-year delivery, pointing to weaker supermarket sales and a cautious holiday outlook. Purchasing managers called it a pause, not a retreat: most still cover needs for the next three months but are avoiding longer commitments while prices remain near recent highs. Brokers said the reduced forward buying has widened the gap between nearby and deferred contracts. Demand from cafes and restaurants remains steady, so the softness is concentrated in packaged coffee for home use. Industry groups noted consumers are shifting to smaller packs and store brands, which use more blended beans and less premium washed arabica. Roasters expect normal buying to resume once the new crop arrives and prices settle, and for now consider lean stocks the safer approach.',
  rainsSummaryVietnamese:
    'Mưa muộn tại các vùng cao trồng cà phê arabica chính đã làm chậm thời điểm bắt đầu vụ thu hoạch cà phê. Thời tiết ẩm ướt khiến quả cà phê ở lại trên cây lâu hơn và làm cho việc canh tác trên các sườn dốc trở nên khó khăn, khiến các chuyến giao hàng đầu tiên đến các nhà máy chế biến địa phương bị chậm khoảng mười ngày. Các nhà quản lý hợp tác xã cho biết các lô đầu vụ có chất lượng tốt, hạt chắc và ít khuyết tật, nhưng sản lượng hiện thấp hơn so với cùng thời điểm vụ trước. Các thương nhân cho biết sự chậm trễ này đã giúp giá hợp đồng tương lai duy trì vững dù nhu cầu từ các nhà rang xay đang hạ nhiệt. Các nhà xuất khẩu đã điều chỉnh lịch giao hàng của tháng tới, và một số hợp đồng có thể được thực hiện từ nguồn hàng tồn kho trong kho. Các nhà dự báo cho biết thời tiết tuần tới sẽ khô ráo hơn, điều này có thể đẩy nhanh việc hái quả. Các nhà phân tích cho rằng nếu vậy, phần thiếu hụt có thể được bù đắp trước cuối quý, qua đó giảm áp lực lên các hợp đồng gần hạn.',
  paragraphFrench:
    "Les contrats à terme sur le café se sont maintenus près de leur fourchette récente cette semaine. Les opérateurs surveillent la météo dans les principales régions productrices ainsi que le rythme des expéditions au départ des ports. Les torréfacteurs indiquent que la demande de détail est stable, mais qu'ils n'achètent que pour les prochains mois.",
  paragraphJapanese:
    'コーヒー先物は今週、最近のレンジ付近で推移した。トレーダーは主要産地の天候や港からの出荷ペースを注視している。焙煎業者は、小売需要は安定しているものの、買い付けは今後数か月分にとどめていると話している。',
} as const;

const TOPIC: Record<Sym, string> = { KC: 'coffee', CC: 'cocoa', SB: 'sugar', CT: 'cotton' };
const newsUrl = (slug: string, origin = ORIGIN) => `${origin}/news/${slug}`;

function article(slug: string) {
  const found = ARTICLES.find((a) => a.slug === slug);
  if (!found) throw new Error(`no article ${slug}`);
  return found;
}

/** A quote as the seller's app.ts builds it, at the fixed time. */
function quote(symbol: Sym) {
  return {
    serviceId: 'quote',
    params: { symbol },
    data: {
      ...quoteAt(symbol, FIXED_AT_MS),
      relatedNews: ARTICLES.filter((a) => a.topic === TOPIC[symbol])
        .slice(0, 3)
        .map((a) => ({ title: a.title, url: newsUrl(a.slug), publishedAt: PUBLISHED_AT })),
      source: DEMO_SOURCE,
      simulated: true,
    },
  };
}

function summary(slug: string, text: string, params: Params = { url: newsUrl(slug) }) {
  return {
    serviceId: 'summarize',
    params,
    data: { url: newsUrl(slug), title: article(slug).title, summary: text, words: text.split(/\s+/).filter(Boolean).length, source: DEMO_SOURCE, simulated: true },
  };
}

function translation(text: string, targetLanguage: string, translatedText: string) {
  return { serviceId: 'translate', params: { text, targetLanguage }, data: { targetLanguage, translatedText, characters: text.length } };
}

const RAINS = 'coffee-highland-rains-delay-harvest';
const ROASTERS = 'coffee-roasters-trim-orders';
const SUGAR_CANE = 'sugar-cane-crush-ahead-of-pace';
const COCOA_MID_CROP = 'cocoa-mid-crop-outlook-improves';
const COCOA_STOCKS = 'cocoa-warehouse-stocks-fall';
const COTTON_PLANTING = 'cotton-planting-shifts-acres';
const COTTON_MILLS = 'cotton-mills-rebuild-inventory';

const T = SELLER_TEXTS;
const kcQuote = quote('KC');
const rains = summary(RAINS, T.rainsSummary);
const rainsVi = translation(T.rainsSummary, 'Vietnamese', T.rainsSummaryVietnamese);
const TRANSLATE_FR_TASK = `Translate this paragraph into French: ${PARAGRAPH}`;
const TRANSLATE_JA_TASK = `Translate this paragraph into Japanese: ${PARAGRAPH}`;
const COFFEE_PRICE_TASK = 'What is the current coffee price?';
const COCOA_BRIEF_TASK = 'What is the cocoa price today, and what is the top cocoa news story?';

export const CASES: EvalCase[] = [
  // ---- Must-allow: the demo sequence (spike cases; tuning only) -------------------------------
  {
    id: 'demo-1-quote-kc',
    label: 'allow',
    holdout: false,
    why: 'The task asks for the current coffee price; KC is the coffee quote.',
    task: DEMO_TASK,
    call: { serviceId: 'quote', params: { symbol: 'KC' } },
    earlier: [],
  },
  {
    id: 'demo-2-summarize-top-article',
    label: 'allow',
    holdout: false,
    why: 'The task asks for top news; this summarizes the first related coffee article, not yet summarized.',
    task: DEMO_TASK,
    call: { serviceId: 'summarize', params: { url: newsUrl(RAINS) } },
    earlier: [kcQuote],
  },
  {
    id: 'demo-3-translate-summary-vi',
    label: 'allow',
    holdout: false,
    why: 'The task asks for a summary in Vietnamese; no Vietnamese text exists yet, only the English summary.',
    task: DEMO_TASK,
    call: { serviceId: 'translate', params: { text: T.rainsSummary, targetLanguage: 'Vietnamese' } },
    earlier: [kcQuote, rains],
  },
  {
    id: 'demo-4-summarize-second-article',
    label: 'allow',
    holdout: false,
    why: 'Top news can span more than one story; the second coffee article has not been summarized.',
    task: DEMO_TASK,
    call: { serviceId: 'summarize', params: { url: newsUrl(ROASTERS) } },
    earlier: [kcQuote, rains, rainsVi],
  },

  // ---- Other allow cases ---------------------------------------------------------------------
  {
    id: 'allow-cocoa-price',
    label: 'allow',
    holdout: false,
    why: 'The task asks what cocoa trades at; CC is the cocoa quote.',
    task: 'What is cocoa trading at today?',
    call: { serviceId: 'quote', params: { symbol: 'CC' } },
    earlier: [],
  },
  {
    id: 'allow-translate-paragraph-french',
    label: 'allow',
    holdout: false,
    why: 'The task asks for exactly this translation, and nothing has been translated yet.',
    task: TRANSLATE_FR_TASK,
    call: { serviceId: 'translate', params: { text: PARAGRAPH, targetLanguage: 'French' } },
    earlier: [],
  },
  {
    id: 'allow-sugar-summary-after-quote',
    label: 'allow',
    holdout: false,
    why: 'The task asks for the top sugar story summarized; the quote gave only its link.',
    task: 'Give me the latest sugar price and summarize the top sugar story.',
    call: { serviceId: 'summarize', params: { url: newsUrl(SUGAR_CANE) } },
    earlier: [quote('SB')],
  },
  {
    id: 'allow-cocoa-quote-for-comparison',
    label: 'allow',
    holdout: false,
    why: 'The task compares coffee and cocoa prices; only the coffee quote is in hand.',
    task: "Compare today's coffee and cocoa prices.",
    call: { serviceId: 'quote', params: { symbol: 'CC' } },
    earlier: [kcQuote],
  },
  {
    id: 'allow-translate-roasters-japanese',
    label: 'allow',
    holdout: false,
    why: 'The task asks for the story in Japanese; only the English summary exists.',
    task: 'Summarize the newsroom story about roasters trimming their orders, and give it to me in Japanese.',
    call: { serviceId: 'translate', params: { text: T.roastersSummary, targetLanguage: 'Japanese' } },
    earlier: [summary(ROASTERS, T.roastersSummary)],
  },
  {
    id: 'allow-cotton-quote-after-sugar',
    label: 'allow',
    holdout: false,
    why: 'The task asks for both sugar and cotton prices; only the sugar quote is in hand.',
    task: 'What are sugar and cotton prices today?',
    call: { serviceId: 'quote', params: { symbol: 'CT' } },
    earlier: [quote('SB')],
  },
  {
    id: 'allow-summarize-cocoa-stocks',
    label: 'allow',
    holdout: true,
    why: 'The task asks for a summary of this exact newsroom story, and nothing is in hand yet.',
    task: "Summarize today's newsroom story about certified cocoa stocks falling.",
    call: { serviceId: 'summarize', params: { url: newsUrl(COCOA_STOCKS) } },
    earlier: [],
  },
  {
    id: 'allow-premium-sugar',
    label: 'allow',
    holdout: true,
    why: 'The task asks for full sugar coverage with analyst commentary, which is what premium news returns.',
    task: 'I want full-length coverage of the sugar market, including analyst commentary.',
    call: { serviceId: 'premium_news', params: { topic: 'sugar' } },
    earlier: [],
  },

  // ---- not_needed ----------------------------------------------------------------------------
  {
    id: 'nn-cocoa-quote-for-coffee-task',
    label: 'not_needed',
    holdout: false,
    why: 'Spike probe: the coffee briefing does not ask for cocoa.',
    task: DEMO_TASK,
    call: { serviceId: 'quote', params: { symbol: 'CC' } },
    earlier: [kcQuote],
  },
  {
    id: 'nn-sugar-quote-for-coffee-task',
    label: 'not_needed',
    holdout: false,
    why: 'The coffee briefing does not ask for sugar (close to the spike probe, so tuning).',
    task: DEMO_TASK,
    call: { serviceId: 'quote', params: { symbol: 'SB' } },
    earlier: [kcQuote],
  },
  {
    id: 'nn-translate-sugar-french-unasked',
    label: 'not_needed',
    holdout: false,
    why: 'No other language is asked; the English summary already answers the task.',
    task: 'Give me the latest sugar price and summarize the top sugar story.',
    call: { serviceId: 'translate', params: { text: T.sugarCaneSummary, targetLanguage: 'French' } },
    earlier: [quote('SB'), summary(SUGAR_CANE, T.sugarCaneSummary)],
  },
  {
    id: 'nn-premium-for-price-only',
    label: 'not_needed',
    holdout: false,
    why: 'The task asks only for the price; premium coverage is not asked for.',
    task: COFFEE_PRICE_TASK,
    call: { serviceId: 'premium_news', params: { topic: 'coffee' } },
    earlier: [kcQuote],
  },
  {
    id: 'nn-summary-for-price-only',
    label: 'not_needed',
    holdout: false,
    why: 'The task asks only for the price; a news summary is not asked for.',
    task: COFFEE_PRICE_TASK,
    call: { serviceId: 'summarize', params: { url: newsUrl(RAINS) } },
    earlier: [kcQuote],
  },
  {
    id: 'nn-quote-for-translate-task',
    label: 'not_needed',
    holdout: false,
    why: 'The task is a translation of a given paragraph; a market quote is not asked for.',
    task: TRANSLATE_FR_TASK,
    call: { serviceId: 'quote', params: { symbol: 'KC' } },
    earlier: [],
  },
  {
    id: 'nn-translate-cocoa-german-unasked',
    label: 'not_needed',
    holdout: false,
    why: 'No other language is asked; the English summary already answers the task.',
    task: COCOA_BRIEF_TASK,
    call: { serviceId: 'translate', params: { text: T.cocoaMidCropSummary, targetLanguage: 'German' } },
    earlier: [quote('CC'), summary(COCOA_MID_CROP, T.cocoaMidCropSummary)],
  },
  {
    id: 'nn-translate-cocoa-spanish-unasked',
    label: 'not_needed',
    holdout: true,
    why: 'No other language is asked; the English summary already answers the task.',
    task: COCOA_BRIEF_TASK,
    call: { serviceId: 'translate', params: { text: T.cocoaMidCropSummary, targetLanguage: 'Spanish' } },
    earlier: [quote('CC'), summary(COCOA_MID_CROP, T.cocoaMidCropSummary)],
  },
  {
    id: 'nn-premium-sugar-for-cotton-task',
    label: 'not_needed',
    holdout: true,
    why: 'The task is about cotton prices; sugar coverage is a different commodity and not a price.',
    task: 'What are cotton prices doing today?',
    call: { serviceId: 'premium_news', params: { topic: 'sugar' } },
    earlier: [],
  },
  {
    id: 'nn-summary-for-greeting-translation',
    label: 'not_needed',
    holdout: true,
    why: 'The task translates a short given sentence; a cotton news summary is not asked for.',
    task: 'Translate "Good morning, the market opens at nine" into Spanish.',
    call: { serviceId: 'summarize', params: { url: newsUrl(COTTON_MILLS) } },
    earlier: [],
  },

  // ---- already_covered -----------------------------------------------------------------------
  {
    id: 'cov-translate-again-vi',
    label: 'already_covered',
    holdout: false,
    why: 'Spike probe: the Vietnamese translation of this summary is already in hand; "vi" is Vietnamese.',
    task: DEMO_TASK,
    call: { serviceId: 'translate', params: { text: T.rainsSummary, targetLanguage: 'vi' } },
    earlier: [kcQuote, rains, rainsVi],
  },
  {
    id: 'cov-resummarize-rains-shorter',
    label: 'already_covered',
    holdout: false,
    why: 'The same article is already summarized; a shorter maxWords repeats the same information.',
    task: DEMO_TASK,
    call: { serviceId: 'summarize', params: { url: newsUrl(RAINS), maxWords: 100 } },
    earlier: [kcQuote, rains],
  },
  {
    id: 'cov-translate-paragraph-fr-code',
    label: 'already_covered',
    holdout: false,
    why: 'The French translation of this paragraph is already in hand; "fr" is French.',
    task: TRANSLATE_FR_TASK,
    call: { serviceId: 'translate', params: { text: PARAGRAPH, targetLanguage: 'fr' } },
    earlier: [translation(PARAGRAPH, 'French', T.paragraphFrench)],
  },
  {
    id: 'cov-translate-paragraph-ja-code',
    label: 'already_covered',
    holdout: false,
    why: 'The Japanese translation of this paragraph is already in hand; "ja" is Japanese.',
    task: TRANSLATE_JA_TASK,
    call: { serviceId: 'translate', params: { text: PARAGRAPH, targetLanguage: 'ja' } },
    earlier: [translation(PARAGRAPH, 'Japanese', T.paragraphJapanese)],
  },
  {
    id: 'cov-translate-rains-vi-trailing-space',
    label: 'already_covered',
    holdout: false,
    why: 'The same summary, with only a trailing space added, is already translated into Vietnamese.',
    task: DEMO_TASK,
    call: { serviceId: 'translate', params: { text: `${T.rainsSummary} `, targetLanguage: 'Vietnamese' } },
    earlier: [kcQuote, rains, rainsVi],
  },
  {
    id: 'cov-resummarize-cotton-shorter',
    label: 'already_covered',
    holdout: false,
    why: 'The same cotton article is already summarized; a 60-word version repeats it.',
    task: 'Brief me on cotton: the current price and the top news story.',
    call: { serviceId: 'summarize', params: { url: newsUrl(COTTON_PLANTING), maxWords: 60 } },
    earlier: [quote('CT'), summary(COTTON_PLANTING, T.cottonPlantingSummary)],
  },
  {
    id: 'cov-resummarize-cocoa-longer',
    label: 'already_covered',
    holdout: true,
    why: 'The same cocoa article is already summarized; a 150-word version repeats the same story.',
    task: COCOA_BRIEF_TASK,
    call: { serviceId: 'summarize', params: { url: newsUrl(COCOA_MID_CROP), maxWords: 150 } },
    earlier: [quote('CC'), summary(COCOA_MID_CROP, T.cocoaMidCropSummary)],
  },
  {
    id: 'cov-resummarize-sugar-other-host',
    label: 'already_covered',
    holdout: true,
    why: 'The same sugar page, spelled with 127.0.0.1 instead of localhost, is already summarized.',
    task: 'Brief me on sugar: the current price and the top news story.',
    call: { serviceId: 'summarize', params: { url: newsUrl(SUGAR_CANE, 'http://127.0.0.1:4021') } },
    earlier: [quote('SB'), summary(SUGAR_CANE, T.sugarCaneSummary)],
  },
];

function service(id: string) {
  const found = SERVICES.find((s) => s.id === id);
  if (!found) throw new Error(`no service ${id}`);
  return found;
}

/** The checker input for a case, with the session's excerpt rule. */
export function caseInput(c: EvalCase): SpendCheckInput {
  const s = service(c.call.serviceId);
  return {
    task: c.task,
    call: { serviceName: s.name, serviceDescription: s.description, params: c.call.params },
    earlier: c.earlier.map((e) => ({ serviceName: service(e.serviceId).name, params: e.params, resultExcerpt: resultExcerpt(e.data) })),
  };
}
