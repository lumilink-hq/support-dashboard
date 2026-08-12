// The public demo lines, in one place.
//
// WHY THIS FILE EXISTS. Four pages advertise a demo number — /demo/hvac,
// /demo/orders, /solutions/service and /solutions/ecommerce — and getting it
// wrong is not a cosmetic bug. The phone path routes by DIALLED NUMBER, and
// `resolve_client_by_number` returns exactly one client, so a number printed on
// the wrong page sends a prospect to the wrong agent. Worse is what /demo/hvac
// did until today: it hardcoded +12135332469, which belongs to TSUNAMI, a
// PAYING CLIENT. Public demo traffic landed on their line, spent their
// allowance, and could be read real order data.
//
// So: one constant per vertical, imported everywhere, never retyped.
//
// ENV OVERRIDE. Each can be overridden without a deploy — useful for a staging
// number or if a line is swapped in a hurry. The literal is the committed
// default because these numbers are OURS: printing one on the wrong page is a
// wasted call, not a client incident, which is the opposite of the old failure.
//
// A NUMBER HERE IS NOT ENOUGH. `clients.phone_number` must also hold it, or the
// call reaches "This phone line isn't configured for a store." See
// scripts/assign-demo-numbers.sql — run that in the same change as editing this.

export type DemoVertical = "ecommerce" | "service";

export type DemoLine = {
  /** E.164, for tel: links and clients.phone_number. */
  tel: string;
  /** How it is shown to a human. */
  display: string;
  /** The demo tenant that must hold `tel` in clients.phone_number. */
  slug: string;
};

export const DEMO_LINES: Record<DemoVertical, DemoLine> = {
  ecommerce: {
    tel: process.env.NEXT_PUBLIC_DEMO_ORDERS_PHONE ?? "+12132610528",
    display:
      process.env.NEXT_PUBLIC_DEMO_ORDERS_PHONE_DISPLAY ?? "(213) 261-0528",
    slug: process.env.NEXT_PUBLIC_DEMO_ORDERS_SLUG ?? "northlake-demo",
  },
  service: {
    tel: process.env.NEXT_PUBLIC_DEMO_HVAC_PHONE ?? "+12137871585",
    display:
      process.env.NEXT_PUBLIC_DEMO_HVAC_PHONE_DISPLAY ?? "(213) 787-1585",
    slug: process.env.NEXT_PUBLIC_DEMO_CLIENT_SLUG ?? "comfort-air-demo",
  },
};

/**
 * Numbers that must NEVER appear on a public page.
 *
 * Tsunami's line. Kept as a named constant so the mistake is greppable and so
 * the test below has something to assert against — a comment saying "don't use
 * this number" does not survive a copy-paste; a failing check does.
 */
export const CLIENT_NUMBERS_DO_NOT_PUBLISH = ["+12135332469"] as const;
