import { ThemeSelector } from "@/src/components/settings/ThemeSelector";

const vaults = [
  { beneficiary: "Orbit Labs", asset: "LUM", unlocked: "68%", nextClaim: "18,500", status: "On schedule" },
  { beneficiary: "Core Grants", asset: "USDC", unlocked: "42%", nextClaim: "7,240", status: "KYC review" },
  { beneficiary: "Ecosystem DAO", asset: "LUM", unlocked: "91%", nextClaim: "31,000", status: "Ready" },
];

const proposals = [
  { title: "Extend cliff for Core Grants tranche", votes: "73% veto", closes: "14h" },
  { title: "Rotate compliance signer", votes: "18% veto", closes: "2d" },
];

const streams = [
  { label: "Active streams", value: "24", detail: "3 finish this week" },
  { label: "Claimable now", value: "$128.4k", detail: "Across 8 beneficiaries" },
  { label: "Pending reviews", value: "5", detail: "KYC and AML checkpoints" },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-5 py-5 sm:px-8 lg:px-10">
        <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-muted">Lumina Network</p>
            <h1 className="mt-2 text-3xl font-semibold text-foreground sm:text-4xl">Vesting operations dashboard</h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <nav className="flex flex-wrap gap-2 text-sm font-medium text-muted-text">
              {["Vaults", "Streams", "Governance", "Compliance"].map((item) => (
                <a className="rounded-md border border-border-light bg-surface px-3 py-2 transition hover:border-primary hover:text-primary" href={`#${item.toLowerCase()}`} key={item}>{item}</a>
              ))}
              <a className="rounded-md border border-border-light bg-surface px-3 py-2 transition hover:border-primary hover:text-primary" href="/pending-tx">Pending</a>
            </nav>
            <ThemeSelector />
          </div>
        </header>

        <section className="grid flex-1 gap-6 py-8 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="flex flex-col gap-6">
            <section className="overflow-hidden rounded-lg border border-border bg-surface" id="vaults">
              <div className="flex flex-col gap-4 border-b border-table-divider p-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-xl font-semibold">Vesting vaults</h2>
                  <p className="mt-1 text-sm text-muted">Track beneficiary unlocks, claim windows, and review states.</p>
                </div>
                <button className="w-fit rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-text transition hover:bg-primary-hover">New vault</button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                  <thead className="bg-table-header-bg text-xs uppercase tracking-[0.12em] text-muted">
                    <tr>
                      <th className="px-5 py-3 font-semibold">Beneficiary</th>
                      <th className="px-5 py-3 font-semibold">Asset</th>
                      <th className="px-5 py-3 font-semibold">Unlocked</th>
                      <th className="px-5 py-3 font-semibold">Next claim</th>
                      <th className="px-5 py-3 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vaults.map((vault) => (
                      <tr className="border-t border-table-divider" key={vault.beneficiary}>
                        <td className="px-5 py-4 font-medium">{vault.beneficiary}</td>
                        <td className="px-5 py-4 text-muted">{vault.asset}</td>
                        <td className="px-5 py-4">
                          <div className="h-2 w-28 rounded-full bg-progress-bg">
                            <div className="h-2 rounded-full bg-progress-fill" style={{ width: vault.unlocked }} />
                          </div>
                          <span className="mt-2 block text-xs text-muted">{vault.unlocked}</span>
                        </td>
                        <td className="px-5 py-4 font-medium">{vault.nextClaim}</td>
                        <td className="px-5 py-4">
                          <span className="rounded-md bg-tag-bg px-2.5 py-1 text-xs font-semibold text-tag-text">{vault.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="grid gap-4 sm:grid-cols-3" id="streams">
              {streams.map((stream) => (
                <article className="rounded-lg border border-border bg-surface p-5" key={stream.label}>
                  <p className="text-sm font-medium text-muted">{stream.label}</p>
                  <p className="mt-3 text-3xl font-semibold">{stream.value}</p>
                  <p className="mt-2 text-sm text-muted">{stream.detail}</p>
                </article>
              ))}
            </section>
          </div>

          <aside className="flex flex-col gap-6">
            <section className="rounded-lg border border-border bg-nav-bg p-5 text-nav-text" id="governance">
              <h2 className="text-xl font-semibold">Governance queue</h2>
              <div className="mt-5 flex flex-col gap-4">
                {proposals.map((proposal) => (
                  <article className="rounded-md border border-nav-border bg-nav-surface p-4" key={proposal.title}>
                    <h3 className="font-medium">{proposal.title}</h3>
                    <div className="mt-4 flex items-center justify-between text-sm text-warning-text">
                      <span>{proposal.votes}</span>
                      <span>Closes in {proposal.closes}</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-border bg-surface p-5" id="compliance">
              <h2 className="text-xl font-semibold">Compliance health</h2>
              <div className="mt-5 space-y-4">
                <div>
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">KYC coverage</span>
                    <span className="text-primary">96%</span>
                  </div>
                  <div className="mt-2 h-2 rounded-full bg-progress-bg">
                    <div className="h-2 w-[96%] rounded-full bg-progress-fill" />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">AML checks</span>
                    <span className="text-danger-text">4 flagged</span>
                  </div>
                  <div className="mt-2 h-2 rounded-full bg-progress-bg">
                    <div className="h-2 w-[78%] rounded-full bg-warning-fill" />
                  </div>
                </div>
              </div>
              <button className="mt-6 w-full rounded-md border border-border-light px-4 py-2 text-sm font-semibold text-muted-text transition hover:border-primary hover:text-primary">Review checkpoints</button>
            </section>
          </aside>
        </section>
      </div>
    </main>
  );
}
