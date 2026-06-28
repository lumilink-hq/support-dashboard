import { redirect } from "next/navigation";

// Unauthenticated requests are bounced to /login by the proxy; everyone else
// lands on the conversations view.
export default function Home() {
  redirect("/conversations");
}
