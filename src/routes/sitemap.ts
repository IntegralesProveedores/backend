import { getSupabase } from "../services/db";
import { RouteContext } from "../lib/router";

const SITE_URL = "https://brotalia.com.ar";

function buildStaticUrls(): string {
  return [
    {
      loc: `${SITE_URL}/`,
      changefreq: "weekly",
      priority: "1.0"
    },
    {
      loc: `${SITE_URL}/productos`,
      changefreq: "daily",
      priority: "0.9"
    }
  ].map(urlToXml).join("");
}

function urlToXml(entry: {
  loc: string;
  changefreq: string;
  priority: string;
  lastmod?: string;
}): string {
  const parts = [
    `  <url>`,
    `    <loc>${escapeXml(entry.loc)}</loc>`,
    entry.lastmod ? `    <lastmod>${escapeXml(entry.lastmod)}</lastmod>` : null,
    `    <changefreq>${escapeXml(entry.changefreq)}</changefreq>`,
    `    <priority>${escapeXml(entry.priority)}</priority>`,
    `  </url>`
  ].filter(Boolean);

  return `${parts.join("\n")}\n`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export async function handleSitemap({ env }: RouteContext) {
  const staticUrls = buildStaticUrls();
  const supabase = getSupabase(env);

  try {
    const [productsResult, categoriesResult] = await Promise.all([
      supabase
        .from("products")
        .select("slug, updated_at, created_at")
        .eq("active", true)
        .is("deleted_at", null)
        .order("name", { ascending: true }),
      supabase
        .from("categories")
        .select("slug")
    ]);

    if (productsResult.error || categoriesResult.error) {
      throw productsResult.error ?? categoriesResult.error;
    }

    const productUrls = (productsResult.data ?? []).map((product: any) =>
      urlToXml({
        loc: `${SITE_URL}/productos/${product.slug}`,
        lastmod: formatDate(product.updated_at ?? product.created_at) ?? undefined,
        changefreq: "weekly",
        priority: "0.8"
      })
    ).join("");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      staticUrls +
      productUrls +
      `</urlset>\n`;

    return new Response(xml, {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=3600"
      }
    });
  } catch {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      staticUrls +
      `</urlset>\n`;

    return new Response(xml, {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=3600"
      }
    });
  }
}
