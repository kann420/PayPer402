import { LimitsForm } from '@/components/forms/limits-form';
import { OnbHeader, Stepper } from '@/components/onboarding/onboarding';
import { load, operatorPage } from '@/lib/page';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Set limits · PayPer402' };

export default async function OnbLimitsPage() {
  const { api } = await operatorPage();
  const view = await load(() => api.get());
  return (
    <>
      <OnbHeader name={view.operator.name} />
      <main className="mx-auto flex w-full max-w-[720px] flex-col gap-7 px-6 pt-4 pb-14">
        <Stepper current={2} linkedEmail={view.wallet.status === 'active' ? view.wallet.payerEmailMasked : null} />
        <LimitsForm variant="onboarding" saved={view.caps} />
      </main>
    </>
  );
}
