import { serializeJsonLd } from "@/lib/structured-data";

/** Renders schema.org data built in lib/structured-data.ts. */
export function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
