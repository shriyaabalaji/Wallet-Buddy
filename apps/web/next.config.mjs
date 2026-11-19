/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@agent-firewall/policy"],
  devIndicators: false,
  // Rules now live on each agent's page (Agents → Rules). A query string (?id=) is carried over.
  async redirects() {
    return [{ source: "/rules", destination: "/agents?tab=rules", permanent: false }];
  },
};
export default nextConfig;
