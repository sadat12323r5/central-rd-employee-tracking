import Login from "@/components/login";
import Portal from "@/components/portal";
import { isSignedIn } from "@/server/auth";
import { employees } from "@/data/employees";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!(await isSignedIn())) return <Login showDemoCredentials={!process.env.DEMO_ADMIN_EMAIL && !process.env.DEMO_ADMIN_PASSWORD} />;
  return <Portal employees={employees} />;
}
