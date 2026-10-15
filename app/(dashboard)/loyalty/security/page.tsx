import { notFound, redirect } from "next/navigation";
import { safeNext, staffAccess } from "../access";
import { MfaStep } from "./mfa-step";

// Staff MFA (0210): set up an authenticator app once, then enter its code
// each time a new session opens /loyalty. Only platform_staff ever see this.

export default async function LoyaltySecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const target = safeNext(next);
  const access = await staffAccess();
  if (access === "none") notFound();
  if (access === "ok") redirect(target);

  return (
    <div className="max-w-md">
      <h1 className="text-lg font-semibold text-gray-900">Loyalty: confirm it&rsquo;s you</h1>
      <p className="mt-1 text-sm text-gray-500">
        Loyalty member data is protected customer data, so staff need an authenticator app (Google
        Authenticator, 1Password, Authy…) on top of their password.
      </p>
      <MfaStep mode={access} next={target} />
    </div>
  );
}
