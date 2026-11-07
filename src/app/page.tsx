import { Suspense } from "react";
import { connection } from "next/server";
import { listSites } from "@/lib/services/sites";

function Score({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="flex flex-col items-center rounded-md bg-zinc-100 px-3 py-1 dark:bg-zinc-800">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value ?? "—"}</span>
    </div>
  );
}

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-bold">AI Visibility — GEO &amp; SEO</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Tracked sites. Manage via <code>/api/sites</code>; see README for the API.
      </p>
      <Suspense fallback={<p className="mt-8 text-zinc-500">Loading…</p>}>
        <SiteList />
      </Suspense>
    </main>
  );
}

async function SiteList() {
  await connection();
  const { items } = await listSites({ limit: 100 });
  return (
    <>
      {items.length === 0 ? (
        <p className="mt-8 text-zinc-500">No sites yet. Run <code>npm run db:seed</code> or POST to /api/sites.</p>
      ) : (
        <ul className="mt-6 divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {items.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <div className="font-medium">{s.title}</div>
                <div className="truncate text-sm text-zinc-500">{s.url}</div>
                <div className="mt-1 text-xs text-zinc-500">{s.openActionItems} open action items</div>
              </div>
              <div className="flex gap-2">
                <Score label="GEO" value={s.latestAudit?.geoScore} />
                <Score label="SEO" value={s.latestAudit?.seoScore} />
                <Score label="E-E-A-T" value={s.latestAudit?.eeatScore} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
