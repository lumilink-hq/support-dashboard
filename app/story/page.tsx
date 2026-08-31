// "/story" — Our Story. Public, indexable, no signed-in redirect.
// Markup lives in components/marketing/story.tsx.

import type { Metadata } from "next";
import { OurStory, STORY_METADATA } from "@/components/marketing/story";

export const metadata: Metadata = {
  ...STORY_METADATA,
  alternates: { canonical: "/story" },
};

export default function StoryPage() {
  return <OurStory />;
}
