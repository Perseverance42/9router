import RouteweaveConnection from "@/shared/components/RouteweaveConnection";

export default function RouteweavePage() {
  return <div className="flex flex-col gap-4"><div><h1 className="text-xl font-semibold text-text-main">RouteWeave</h1><p className="mt-1 text-sm text-text-muted">Global backend connection. Select the RouteWeave strategy on each combo; manage classification and routing policy in the backend UI.</p></div><RouteweaveConnection /></div>;
}
