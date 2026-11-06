# TV project reference ledger

Research date: **2026-10-25**. These are candidates supplied by the accompanying
read-only project survey. They have not been installed, executed or validated on
any household device. Check upstream again before a proposal: popularity, model
support and firmware constraints can change. Confidence here is in the stated
project role, not compatibility with an unknown TV.

| Platform | Reference | Role and boundary | License reported by survey |
| --- | --- | --- | --- |
| Android / Google TV | [CleanYourTV](https://github.com/Gathin23/cleanyourtv) | Non-root ADB package-disable and launcher workflows; candidate lists require individual review. [Discussion 304](https://github.com/Gathin23/cleanyourtv/discussions/304) reports broken Accounts/Profile settings after disabling a helper. | MIT code; separate font license |
| Android / Google TV | [Projectivy](https://github.com/spocky/miproja1) | Launcher UX benchmark; repository presence does not establish that app source is open-source. | App source license not established |
| Android / Google TV | [LTvLauncher](https://github.com/leanbitlab-org/LtvLauncher) | Open-source launcher candidate; evaluate navigation and recovery separately from privacy claims. | GPL-3.0 |
| Samsung / Tizen | [TizenBrew](https://github.com/reisxd/TizenBrew), [TizenTube](https://github.com/reisxd/TizenTube) | Developer-mode application tooling, documented Tizen 3.0 / 2017+ baseline; exact device support still needs checking. Not OS rooting or blanket telemetry removal. | GPL-3.0 |
| LG / webOS | [Dev Manager](https://github.com/webosbrew/dev-manager-desktop) | Developer-mode and root workflows; capabilities depend on privilege. | Apache-2.0 |
| LG / webOS | [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel) | Privileged features require root; don't conflate these with developer mode. | MIT |
| LG / webOS | [Luma](https://github.com/ecklf/lg-luma) | Rust/SDL native rooted-webOS launcher with a synthetic desktop preview; experimental Home replacement. | MIT |
| Analysis | [Zeek](https://github.com/zeek/zeek), [Wireshark / TShark](https://www.wireshark.org/) | Potential later offline analysis formats, not capture commands for this increment. | BSD / GPL respectively |
| Analysis | [IoT Inspector](https://github.com/nyu-mlab/iot-inspector-client) | Schema/reference study only; no capture launch. | Apache-2.0 |

Historical RootMyTV exploits are not a universal current root method. Record the
exact model, region, OS build, privilege and upstream source date before evaluating
any modification. Reversibility must include how to recover the original launcher
and account/settings access; “can re-enable a package” is insufficient if the UI
needed to do that is no longer reachable.

Do not copy third-party code into this MIT project without license review. Links
and independently designed metadata do not require executing these tools. UX
improvements and reduced telemetry are separate hypotheses and need separate
measurements.

Future evidence import should preserve the distinction between a DNS query, a
connection, endpoint attribution, decoded data and demonstrated behavior. None is
an automatic “spying” label. The current bundle's evidence summaries can record
these levels explicitly; adding a typed importer awaits a concrete authorized
source format and synthetic examples.

No candidate authorizes discovery, ADB connections, developer mode, rooting,
package changes, captures, uploads or model calls. The next permitted work is
still offline fixture/schema/viewer development; real-device work needs a separate
scope and consent.

## Lead: AeroTizen (noted 7 Nov 2026, not started)

https://github.com/helalaou/AeroTizen — MIT, JavaScript, ~90 stars, active (updated 6 Nov 2026). A replacement
home screen for Samsung Tizen TVs plus a CLI that signs/installs any `.wgt` without Tizen Studio and lists/removes
preinstalled bloat where firmware allows.

- Fit for our TV (2017 UA65MU8000, Tizen 3): untested. Their oldest tested set is a 2019 RU8000 (Tizen 5.0, "runs");
  on 2020–21 sets Home-return and power-on launch often fail, so expect the launcher not to replace Samsung's Home
  reliably on Tizen 3.
- What could help us: (1) bloat/privacy cleanup (TV Plus autoplay, ad rows) — same goal as the CleanYourTV notes;
  (2) power-on/auto-start of an app — could make Onto the TV open when the TV turns on (channel-first home in one
  press); (3) its signing/install CLI as an alternative to our M2 `vd_appinstall` path.
- If picked up: TV work needs Ian's go-ahead (never 21:00–07:00); start read-only (list apps/bloat), report before
  removing or installing anything.
