import { describe, expect, it } from 'vitest';
import { installLicenceBannerFilter, isLicenceBannerLine } from './licence-banner';

/** The banner as AG Studio 3.0.0 prints it without a key (one console.error call per line). */
const BANNER = [
  '****************************************************************************************************************************',
  '****************************************************************************************************************************',
  '********************************************** AG Studio Pro with AI License ***********************************************',
  '************************************************** License Key Not Found ***************************************************',
  '* All AG Studio Pro with AI features are unlocked for trial.                                                               *',
  '* If you want to hide the watermark please email info@ag-grid.com for a trial license key.                                 *',
  '****************************************************************************************************************************',
];

function fakeConsole() {
  const calls: { level: string; args: unknown[] }[] = [];
  const target = {
    error: (...args: unknown[]) => calls.push({ level: 'error', args }),
    info: (...args: unknown[]) => calls.push({ level: 'info', args }),
  } as unknown as Console;
  return { target, calls };
}

describe('licence banner matcher', () => {
  it('matches every banner line', () => {
    for (const line of BANNER) expect(isLicenceBannerLine([line]), line).toBe(true);
  });

  it('lets every other error through', () => {
    for (const args of [
      ['Failed to load resource: 404'],
      ['* a list item *'],
      ['AG Studio failed to render the widget'],
      ['**'],
      [new Error('AG Studio License Key')],
      ['* License Key Not Found *', 'extra argument'],
      [{ message: '* AG Studio *' }],
    ]) {
      expect(isLicenceBannerLine(args), JSON.stringify(args)).toBe(false);
    }
  });
});

describe('installLicenceBannerFilter', () => {
  it('routes the banner to console.info in development, once', () => {
    const { target, calls } = fakeConsole();
    installLicenceBannerFilter(target, 'development');
    installLicenceBannerFilter(target, 'development');
    for (const line of BANNER) target.error(line);
    target.error('real problem', 42);
    expect(calls.filter((c) => c.level === 'info')).toHaveLength(BANNER.length);
    expect(calls.filter((c) => c.level === 'error')).toEqual([{ level: 'error', args: ['real problem', 42] }]);
  });

  it('changes nothing in production', () => {
    const { target, calls } = fakeConsole();
    const before = target.error;
    installLicenceBannerFilter(target, 'production');
    expect(target.error).toBe(before);
    target.error(BANNER[2]);
    expect(calls).toEqual([{ level: 'error', args: [BANNER[2]] }]);
  });
});
