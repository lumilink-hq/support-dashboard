"use client";

import { useEffect } from "react";

// Mounts the ElevenLabs conversational widget. The <elevenlabs-convai> custom
// element is upgraded by the embed script once it loads; we inject the element
// via innerHTML (agentId is a trusted constant) and append the script once.
export function LumiWidget({ agentId }: { agentId: string }) {
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

  return (
    <div
      dangerouslySetInnerHTML={{
        __html: `<elevenlabs-convai agent-id="${agentId}"></elevenlabs-convai>`,
      }}
    />
  );
}
