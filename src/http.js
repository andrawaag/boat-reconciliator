// fetch() that is polite to public APIs: retries on 429/503 with backoff, honouring Retry-After.
export async function politeJson(ctx, url, label) {
  for (let attempt = 0; ; attempt++) {
    const res = await ctx.fetch(url, { headers: { Accept: "application/json", ...ctx.headers } });
    if (res.ok) return res.json();
    if (![429, 503].includes(res.status) || attempt >= 4) throw new Error(`${label} HTTP ${res.status} for ${url}`);
    const wait = Number(res.headers.get("retry-after")) * 1000 || 1000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(wait, 20000)));
  }
}
