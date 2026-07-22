"use client";

import { useEffect, useRef } from "react";

/**
 * Embeds the ElevenLabs Conversational-AI web widget.
 *
 * The `@elevenlabs/convai-widget-embed` script registers a custom element,
 * `<elevenlabs-convai agent-id="...">`, that renders a floating "talk" button
 * (bottom-right by default) and handles mic capture + the live voice session
 * entirely in the browser. We create the element imperatively so we don't have
 * to declare a custom JSX intrinsic element, and we load the embed script once.
 *
 * `dynamicVariables` is how the browser tells the shared agent which tenant this
 * is — we pass `client_slug`, which the scheduling tool maps to `client_ref` to
 * route the booking (the web analog of the dialed phone number).
 */
export default function ConvaiWidget({
  agentId,
  dynamicVariables,
}: {
  agentId: string;
  dynamicVariables?: Record<string, string>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const widget = document.createElement("elevenlabs-convai");
    widget.setAttribute("agent-id", agentId);
    if (dynamicVariables && Object.keys(dynamicVariables).length > 0) {
      widget.setAttribute("dynamic-variables", JSON.stringify(dynamicVariables));
    }
    container.appendChild(widget);

    // Load the embed script a single time, even across client-side navigations.
    const SCRIPT_ID = "elevenlabs-convai-embed";
    if (!document.getElementById(SCRIPT_ID)) {
      const script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.src = "https://unpkg.com/@elevenlabs/convai-widget-embed";
      script.async = true;
      script.type = "text/javascript";
      document.body.appendChild(script);
    }

    return () => {
      widget.remove();
    };
  }, [agentId, dynamicVariables]);

  return <div ref={containerRef} aria-hidden />;
}
