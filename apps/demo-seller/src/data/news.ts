/**
 * Newsroom fixtures (design spec §3.5). Fictional demo content: no real companies, people or
 * brands. `publishedAt` is always the request day, so "today's news" works on any day.
 */
import type { Topic } from '../services';

export interface Article {
  slug: string;
  topic: Topic;
  title: string;
  body: string;
}

export const ARTICLES: readonly Article[] = [
  {
    slug: 'coffee-highland-rains-delay-harvest',
    topic: 'coffee',
    title: 'Late rains in the highlands slow the coffee harvest',
    body:
      'Growers across the main arabica highlands reported a slower start to the harvest this week after an unusual run of late rains kept ' +
      'cherries on the trees longer than planned. Field crews said the wet weather made steep slopes hard to work and pushed back the ' +
      'first deliveries to local mills by about ten days. Cooperative managers in the region said the quality of the early lots looked ' +
      'good, with dense beans and few defects, but that volumes were running below last season at the same point. Traders watching the ' +
      'futures market said the delay was one reason prices held firm even as demand from roasters cooled. Exporters added that shipping ' +
      'schedules for the coming month had been adjusted, and that some contracts may be filled from warehouse stocks instead. Weather ' +
      'forecasters expect drier conditions next week, which would let picking speed up. If that happens, analysts said, the early ' +
      'shortfall could be made up before the end of the quarter, easing the pressure on nearby contracts.',
  },
  {
    slug: 'coffee-roasters-trim-orders',
    topic: 'coffee',
    title: 'Roasters trim forward orders as retail demand cools',
    body:
      'Several mid-sized roasters said they are buying less coffee for delivery later in the year, citing softer sales in supermarkets ' +
      'and a cautious outlook for the holiday season. Purchasing managers described the change as a pause rather than a retreat: most ' +
      'are still covering their needs for the next three months but are holding off on longer commitments while prices stay near ' +
      'recent highs. Brokers said the slowdown in forward buying has widened the gap between nearby and deferred contracts. One broker ' +
      'noted that cafes and restaurants are still ordering steadily, so the weakness is mostly in packaged coffee for home use. Industry ' +
      'groups said consumers have been switching to smaller packs and store labels, which use more blended beans and less of the ' +
      'premium washed arabica. The roasters expect to return to normal buying once the new crop arrives and prices settle. For now, ' +
      'they said, keeping stocks lean is the safer choice.',
  },
  {
    slug: 'coffee-port-congestion-eases',
    topic: 'coffee',
    title: 'Port congestion eases, freeing delayed coffee shipments',
    body:
      'Waiting times at the main coffee export port fell this week after a backlog of container vessels was cleared, according to ' +
      'shipping agents. At the peak of the congestion last month, some cargoes waited more than two weeks for a berth, and exporters ' +
      'warned that buyers in Europe and North America would face late arrivals. Port officials said extra cranes and longer working ' +
      'hours helped bring the queue down to a few days. Exporters welcomed the change but said freight costs remain higher than a year ' +
      'ago, which adds to the price paid by importers. A logistics consultant said the improvement should release several thousand ' +
      'tonnes of coffee that had been stuck on the docks, adding to supply in consuming countries over the next few weeks. Traders said ' +
      'the news was mildly bearish for futures, because importers who had been short of beans may now be able to wait before buying ' +
      'more.',
  },
  {
    slug: 'cocoa-mid-crop-outlook-improves',
    topic: 'cocoa',
    title: 'Mid-crop outlook improves after steady rainfall',
    body:
      'Farmers in the main West African growing belt said steady rainfall over the past month has improved the outlook for the cocoa ' +
      'mid-crop, which is harvested in the second half of the season. Field surveys by a growers association found more flowers and ' +
      'young pods on trees than at the same time last year. Agronomists cautioned that the crop still needs dry, sunny spells in the ' +
      'coming weeks to ripen well, and that heavy rain can spread black pod disease. Buyers at regional collection points said early ' +
      'arrivals were of good size. The improved outlook comes after two seasons of poor harvests that pushed cocoa prices to record ' +
      'levels and forced chocolate makers to raise prices. Market analysts said a better mid-crop would not end the supply deficit on ' +
      'its own, but could slow the drawdown of warehouse stocks. Futures fell slightly on the report as some speculative buyers took ' +
      'profits.',
  },
  {
    slug: 'cocoa-grinders-report-lower-demand',
    topic: 'cocoa',
    title: 'Grinders report lower demand as chocolate prices rise',
    body:
      'Quarterly figures from cocoa processors showed that the amount of beans ground into cocoa butter and powder fell compared with ' +
      'the same quarter last year. Processing companies said high bean prices have been passed on to chocolate makers, who in turn have ' +
      'raised shelf prices and reduced the cocoa content in some products. Analysts said the drop in grinding is a sign that high prices ' +
      'are starting to cut consumption, which could help balance the market over time. A trade economist said the figures were weaker ' +
      'than expected in Europe and stronger than expected in Asia, where demand for cocoa drinks and snacks keeps growing. Some ' +
      'processors are running plants at reduced hours to avoid building up stocks of butter and powder. The market reaction was muted, ' +
      'traders said, because the figures were largely priced in after weak retail sales data earlier in the month.',
  },
  {
    slug: 'cocoa-warehouse-stocks-fall',
    topic: 'cocoa',
    title: 'Certified cocoa stocks fall to a multi-year low',
    body:
      'Cocoa held in exchange-certified warehouses has fallen to its lowest level in several years, according to the latest weekly ' +
      'report. Certified stocks are the beans that can be delivered against futures contracts, so a low level can make nearby contracts ' +
      'volatile when they approach expiry. Warehouse operators said fewer new lots are being graded because exporters are selling ' +
      'directly to processors instead of sending beans to exchange warehouses. A market strategist said the low stocks explain why the ' +
      'front-month contract has been trading at a large premium to later months. Some traders expect the premium to narrow once the ' +
      'mid-crop arrives in volume, while others warn that any weather problem could send prices sharply higher again. Processors said ' +
      'they are keeping their own stocks higher than usual to protect against sudden shortages, which also reduces the beans available ' +
      'to the exchange.',
  },
  {
    slug: 'sugar-cane-crush-ahead-of-pace',
    topic: 'sugar',
    title: 'Cane crush runs ahead of pace in the southern growing region',
    body:
      'Mills in the largest sugar cane region crushed more cane in the past two weeks than analysts had forecast, helped by dry weather ' +
      'that kept harvesters running. An industry body said the share of cane used to make sugar, rather than ethanol, stayed high ' +
      'because sugar remains more profitable than fuel at current prices. That means more raw sugar is available for export later in ' +
      'the year. Analysts said the strong crush was the main reason raw sugar futures slipped this week. However, agronomists warned ' +
      'that the dry weather which helped the harvest may hurt next year’s cane if it lasts into the planting season. Mill managers ' +
      'said sugar content in the cane was slightly lower than last year, a common effect of a fast harvest. Shipping data showed a long ' +
      'line of vessels waiting to load sugar at the main ports, a sign that buyers in Asia and Africa are still active.',
  },
  {
    slug: 'sugar-monsoon-supports-crop',
    topic: 'sugar',
    title: 'Good monsoon supports next season’s sugar crop in South Asia',
    body:
      'A strong monsoon season has filled reservoirs and improved soil moisture in the main cane-growing states of South Asia, according ' +
      'to farm officials. Growers said the rains came at the right time for young cane, and early estimates point to a larger crop next ' +
      'season. Trade groups expect the government to review export rules once the size of the crop is clearer, which could allow more ' +
      'sugar to reach the world market. Analysts said the possibility of higher exports has added to pressure on prices, alongside the ' +
      'strong harvest elsewhere. Some farmers reported pest problems in low-lying fields that flooded during the heaviest rains, but ' +
      'officials described the damage as limited. Refiners said they would wait for the first official crop estimate, due next month, ' +
      'before changing their buying plans. Consumer demand for sugar in the region remains steady, helped by the festival season.',
  },
  {
    slug: 'cotton-planting-shifts-acres',
    topic: 'cotton',
    title: 'Farmers shift acres away from cotton as prices lag',
    body:
      'Early surveys of planting plans suggest that farmers in several major growing areas will plant less cotton next season and more ' +
      'grain and oilseeds, which have offered better returns. Extension agents said many growers are worried about the cost of ' +
      'fertilizer and fuel, and that cotton needs more inputs per acre than some competing crops. A farm economist said the shift could ' +
      'reduce cotton output if weather is normal, which would support prices later. For now, however, the market is focused on large ' +
      'carry-over stocks from the current season. Spinning mills said yarn demand has been uneven, with strong orders for basic fabrics ' +
      'and weaker orders for fashion items. Merchants said they are seeing more interest from mills in Asia that had been buying from ' +
      'other origins. Cotton futures were little changed on the survey, as traders wait for official planting figures in the spring.',
  },
  {
    slug: 'cotton-mills-rebuild-inventory',
    topic: 'cotton',
    title: 'Textile mills start to rebuild cotton inventory',
    body:
      'Spinning mills in several importing countries have started to buy cotton again after months of running down their stocks, ' +
      'according to merchants and shipping data. Mill buyers said lower prices earlier in the season made it attractive to cover needs ' +
      'for the first half of next year. A textile association said orders from clothing brands have improved slightly, although they ' +
      'are still below the levels seen two years ago. Merchants said the renewed buying has helped clear some of the cotton held in ' +
      'warehouses at ports, and that export sales reports for the past three weeks have been above average. Analysts cautioned that the ' +
      'recovery depends on consumer spending on clothing, which has been soft. They also noted that synthetic fibres remain cheap, which ' +
      'limits how much mills are willing to pay for cotton. Futures rose modestly on the export data.',
  },
];

/** One fictional analyst note per topic (40 to 80 words), for premium news. */
export const ANALYST_NOTES: Record<Topic, string> = {
  coffee:
    'Our view: the late harvest and lean roaster stocks keep nearby coffee contracts supported for now, but cleared port backlogs and ' +
    'softer retail demand point to easier prices once new-crop beans arrive. We expect a wide trading range over the next month and ' +
    'would watch weekly mill deliveries as the clearest early signal.',
  cocoa:
    'Our view: the better mid-crop outlook and weaker grinding suggest the worst of the cocoa deficit may be passing, yet certified ' +
    'stocks are so low that nearby contracts can still spike on any weather problem. We favour caution on the front month and expect ' +
    'the spread between near and far contracts to narrow slowly.',
  sugar:
    'Our view: a fast cane crush and a good monsoon both add to supply, so the balance of risks for raw sugar leans lower over the next ' +
    'quarter. Policy on exports is the main wild card. A larger export allowance would add pressure, while a dry planting season could ' +
    'reverse the trend next year.',
  cotton:
    'Our view: renewed mill buying gives cotton a floor, but large carry-over stocks and cheap synthetic fibres limit any rally. Lower ' +
    'planting next season is a supportive story for later contracts rather than for nearby ones. We would watch weekly export sales ' +
    'and yarn orders before changing this view.',
};

export function articlesFor(topic: Topic): Article[] {
  return ARTICLES.filter((article) => article.topic === topic);
}

export function articleBySlug(slug: string): Article | undefined {
  return ARTICLES.find((article) => article.slug === slug);
}

/** Number of words, counted as runs of non-space characters. */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}
