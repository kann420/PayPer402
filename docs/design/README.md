# PayPer402 UI design (frozen)

These are the source files of the "PayPer402 UI Design" canvas, made in Claude Design and frozen at
canvas version `1792213018-362b` (2026-10-17). The Phase 4 web app is built from them. Later edits
to the canvas do not flow in; a design change after the freeze goes through the Phase 4 specs.

## What is here

- `canvas/*.dc.html`: one file per artboard (36). Each is a self-contained page with inline
  styles. The `<script type="text/x-dc">` block at the end holds the sample data and the variant
  logic.
- `canvas/canvas.json`: the canvas index: artboard titles, sizes and order.
- `canvas/assets/logo.png`: the PayPer402 mark used by the boards (256 × 256).

The boards reference images as `/_blob/<id>`:

| Reference | File |
|---|---|
| `/_blob/561a272e3f3c781b2b4d5555d2521dd1` | `canvas/assets/logo.png` |
| `/_blob/f0ff82cbbe3d272de32f0f7edb4c467a` | `canvas/assets/paypal-mark.webp`: the PayPal logo, imported on 2026-10-17 after the user changed the Trademark rule in CLAUDE.md. Use it unaltered, and only where it shows PayPal as the payment rail (the landing hero's settlement step). |

The boards load `./support.js`, the Claude Design runtime, which is not part of the repo. They are a
reference to read, not pages to open.

## How to read a board

- Inline `style="…"` attributes hold the exact look: colours, sizes, spacing and radii.
- `{{ name }}` is a value from `renderVals()` in the board's script.
- `<sc-if value="{{ x }}">` shows its content only when `x` is true. `<sc-for list="{{ xs }}"
  as="x">` repeats it for each item.
- `<dc-import name="Overview" variant="stopped">` renders another board with a prop. The small
  variant boards (`OverviewStopped`, `ChargeDetailDeclined`, …) are only this. Their states are
  defined in the base board's `renderVals()`.
- Sample data in the scripts is illustrative. Real data comes from the facilitator.

## Precedence

When sources disagree:

1. CLAUDE.md constraints:
   - the PayPal logo only unaltered, and only as the payment rail
   - no imitation of PayPal's look
   - sandbox only
   - English UI copy

   These supersede the brief's older "no PayPal logo" line.
2. The Phase 4 design spec ([docs/spec/web-app.md](../spec/web-app.md)).
3. [docs/ui-design-fixes.md](../ui-design-fixes.md) for content, copy, states and code samples.
4. These boards for layout and visual style.
5. [docs/ui-brief.md](../ui-brief.md).

## Boards

| Board | Screen |
|---|---|
| `Main` | Landing, desktop, with the animated hero |
| `LandingMobile` | Landing at 390 px |
| `SignIn` | Demo account picker |
| `OnbLink`, `OnbLinkCollecting`, `OnbLinkFailed`, `OnbLinkReturn` | Onboarding step 1 and the link states |
| `OnbLimits` | Onboarding step 2 |
| `OnbAgent` | Onboarding step 3 (key shown once) |
| `OnbDone` | Onboarding done |
| `Overview` and its variants (`Stopped`, `Empty`, `Unlinking`, `NotLinked`, `Declined`) | Operator overview |
| `Agents`, `AgentDetail` | Agents list (with the New agent drawer) and detail |
| `Charges`, `ChargeDetail` and its variants (`Charging`, `Declined`, `Stopped`, `Review`) | PayPal charges |
| `LiveRun`, `LiveRunFinished`, `LiveRunBlocked` | Live agent run |
| `Settings` and its variants (`Unlinking`, `NotLinked`, `Declined`) | PayPal link and limits |
| `SellerOverview`, `SellerEndpoints`, `SellerCharges` | Seller console |
| `DesignSystem` | Tokens, type, components, chart palette |
| `States` | Empty, loading, toast, error and offline states |
