import { Landing } from '@/components/landing/landing';
import './landing.css';

export const metadata = {
  title: 'PayPer402 · Pay-per-call for AI agents, settled with PayPal',
  description: 'AI agents pay for APIs one call at a time over HTTP 402. The calls add up and are charged to a PayPal account once.',
};

/** The landing page (design spec §10.1). Repository links appear only when `NEXT_PUBLIC_REPO_URL` is set. */
export default function Home() {
  const repo = process.env['NEXT_PUBLIC_REPO_URL']?.trim();
  return <Landing repoUrl={repo === undefined || repo === '' ? undefined : repo} />;
}
