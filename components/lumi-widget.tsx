"use client";

import { useEffect } from "react";

// Mounts the ElevenLabs conversational widget. The <elevenlabs-convai> custom
// element is upgraded by the embed script once it loads; we inject the element
// via innerHTML (agentId + clientSlug are trusted constants) and append the
// script once. A browser call has no dialed number, so we pass the tenant's slug
// as the `client_slug` dynamic variable — the tools and personalization webhook
// route by that instead (demo clients only).
export function LumiWidget({
  agentId,
  clientSlug,
}: {
  agentId: string;
  clientSlug?: string;
}) {
  useEffect(() => {
    const src = "https://unpkg.com/@elevenlabs/convai-widget-embed";
    if (!document.querySelector(`script[src="${src}"]`)) {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.type = "text/javascript";
      document.body.appendChild(s);
    }
  }, []);

  const dynAttr = clientSlug
    ? ` dynamic-variables='{"client_slug":"${clientSlug}"}'`
    : "";

  return (
    <div
      dangerouslySetInnerHTML={{
        __html: `<elevenlabs-convai agent-id="${agentId}"${dynAttr}></elevenlabs-convai>`,
      }}
    />
  );
}
