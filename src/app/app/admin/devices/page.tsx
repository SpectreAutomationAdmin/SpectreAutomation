import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { listDevices, registerDevice, disableDevice } from "@/lib/hardware";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function registerAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await registerDevice(p, clubId, {
      serial: String(formData.get("serial") ?? ""),
      kind: formData.get("kind") as "GPS_BAG_TAG" | "DOOR_ACCESS" | "LOCKER" | "BEVERAGE_CART_RADIO" | "DRIVING_RANGE_CAMERA" | "PARKING_GATE" | "GEOFENCE",
      label: String(formData.get("label") ?? "") || null,
      vendor: String(formData.get("vendor") ?? "") || null,
      authToken: String(formData.get("authToken") ?? "") || null,
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/devices?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/devices");
}

async function disableAction(deviceId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await disableDevice(p, deviceId, "Disabled from admin UI"); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/devices?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/devices");
}

export default async function DevicesPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:read")) redirect("/app/admin");
  const canWrite = hasPermission(p, clubId, "settings:write");

  const devices = await listDevices(p, clubId);

  return (
    <div>
      <h1 className="page-title">Hardware Devices</h1>
      <p className="mt-1 text-stone-500">Device registry for GPS bag tags, door access, lockers, beverage-cart radios, range cameras, and parking gates. Devices POST to <span className="font-mono text-xs">/api/hardware/events</span>; their auth-token hash is verified per request.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Devices ({devices.length})</div>
          <table className="table-base">
            <thead><tr><th>Serial</th><th>Kind</th><th>Label</th><th>Vendor</th><th>Status</th><th>Last heartbeat</th><th></th></tr></thead>
            <tbody>
              {devices.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-stone-500">No devices registered.</td></tr>}
              {devices.map((d) => (
                <tr key={d.id}>
                  <td className="text-xs font-mono">{d.serial}</td>
                  <td className="text-xs">{d.kind}</td>
                  <td className="text-xs">{d.label ?? "—"}</td>
                  <td className="text-xs">{d.vendor ?? "—"}</td>
                  <td><Badge status={d.status} /></td>
                  <td className="text-xs">{d.statuses[0]?.lastHeartbeat ? formatDate(d.statuses[0].lastHeartbeat) : "—"}</td>
                  <td className="text-right text-xs">
                    {canWrite && d.status === "ACTIVE" && (
                      <form action={disableAction.bind(null, d.id)} className="inline"><button className="text-red-600 hover:underline">Disable</button></form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canWrite && (
          <form action={registerAction} className="card card-body space-y-3">
            <h2 className="section-title text-lg">Register device</h2>
            <div><label className="label">Serial</label><input className="input font-mono" name="serial" required /></div>
            <div>
              <label className="label">Kind</label>
              <select className="select" name="kind">
                <option value="GPS_BAG_TAG">GPS bag tag</option>
                <option value="DOOR_ACCESS">Door access</option>
                <option value="LOCKER">Locker</option>
                <option value="BEVERAGE_CART_RADIO">Beverage cart radio</option>
                <option value="DRIVING_RANGE_CAMERA">Driving range camera</option>
                <option value="PARKING_GATE">Parking gate</option>
                <option value="GEOFENCE">Geofence</option>
              </select>
            </div>
            <div><label className="label">Label</label><input className="input" name="label" /></div>
            <div><label className="label">Vendor</label><input className="input" name="vendor" /></div>
            <div><label className="label">Auth token (raw; stored hashed)</label><input className="input font-mono" name="authToken" /></div>
            <button className="btn btn-primary">Register</button>
          </form>
        )}
      </div>
    </div>
  );
}

void Link;
