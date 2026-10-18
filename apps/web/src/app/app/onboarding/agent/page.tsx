import { OnbHeader, Stepper } from '@/components/onboarding/onboarding';
import { load, operatorPage } from '@/lib/page';
import { FirstAgent } from './first-agent';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'First agent · PayPer402' };

export default async function OnbAgentPage() {
  const { api } = await operatorPage();
  const view = await load(() => api.get());
  return (
    <>
      <OnbHeader name={view.operator.name} />
      <main className="mx-auto flex w-full max-w-[720px] flex-col gap-7 px-6 pt-4 pb-12">
        <Stepper current={3} linkedEmail={view.wallet.status === 'active' ? view.wallet.payerEmailMasked : null} />
        <FirstAgent />
      </main>
    </>
  );
}
