import { requirePermission } from "@/lib/auth/authorization";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { listDevicesForAdmin } from "@/services/device.service";
import { describeAge, evaluateSyncHealth } from "@/lib/sync/health";
import SimpleForm from "@/components/SimpleForm";
import RowActionForm from "@/components/RowActionForm";
import {
  createDeviceAction,
  deleteDeviceAction,
  toggleDeviceActiveAction,
  updateDeviceAction,
} from "./actions";

function syncText(sync: {
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  intervalSeconds: number;
} | null) {
  if (!sync) return { label: "Never synced", className: "text-zinc-500" };
  const health = evaluateSyncHealth(sync, Date.now());
  if (health.state === "ok") {
    return {
      label: `OK · ${health.minutesSince === null ? "just now" : describeAge(health.minutesSince)}`,
      className: "text-green-700",
    };
  }
  if (health.state === "delayed") {
    return {
      label: `Delayed · ${health.minutesSince === null ? "unknown" : describeAge(health.minutesSince)}`,
      className: "text-amber-700",
    };
  }
  return {
    label:
      health.minutesSince === null
        ? "Failing · no successful sync yet"
        : `Down · ${describeAge(health.minutesSince)}`,
    className: "text-red-700",
  };
}

export default async function AttendanceDevicesPage() {
  await requirePermission(PERMISSIONS.ATTENDANCE_SETTINGS);
  const devices = await listDevicesForAdmin();

  return (
    <div className="w-full space-y-4">
      <h1 className="text-2xl font-semibold text-red-800">Biometric devices</h1>
      <p className="max-w-3xl text-sm text-zinc-600">
        Manage ZKTeco attendance devices. Active devices are read by the sync
        worker. After adding or changing devices, restart the sync worker so it
        picks up the new configuration.
      </p>

      <div className="flex justify-center w-full">
        <section className="flex items-center justify-center rounded-md bg-white p-4 shadow-xl w-full md:max-w-md">
          <div className="max-w-md w-full">
            <h2 className="mb-3 font-medium">Add device</h2>
            <SimpleForm
              action={createDeviceAction}
              resetOnSuccess
              submitLabel="Add device"
              fields={[
                { name: "name", label: "Device name", required: true, placeholder: "e.g. Main Gate" },
                { name: "ip", label: "IP address", required: true, placeholder: "10.100.1.169" },
                { name: "port", label: "Port", type: "number", defaultValue: "4370", required: true },
                { name: "commKey", label: "Comm key", type: "number", defaultValue: "0", required: true },
              ]}
            />
          </div>
        </section>
      </div>

      <section className="rounded-md bg-white p-4 shadow-lg">
        <div className="mb-3">
          <h2 className="font-medium">Devices</h2>
          <p className="text-sm text-zinc-500">{devices.length} device(s) configured.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-red-800 text-white text-left">
              <tr>
                <th className="p-3">Name</th>
                <th className="p-3">IP / Port</th>
                <th className="p-3">Comm key</th>
                <th className="p-3">Status</th>
                <th className="p-3">Sync</th>
                <th className="p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {devices.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-4 text-center text-zinc-500">
                    No devices configured. The sync worker will fall back to
                    environment variables until you add devices here.
                  </td>
                </tr>
              )}
              {devices.map((d) => {
                const sync = syncText(d.sync);
                return (
                  <tr key={d.id} className="border-t align-top">
                    <td className="p-3 font-medium">{d.name}</td>
                    <td className="p-3 whitespace-nowrap">
                      {d.ip}:{d.port}
                    </td>
                    <td className="p-3">{d.commKey}</td>
                    <td className="p-3">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${
                          d.isActive
                            ? "bg-green-100 text-green-800"
                            : "bg-zinc-200 text-zinc-700"
                        }`}
                      >
                        {d.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="p-3">
                      <div className={sync.className}>{sync.label}</div>
                      {d.sync?.lastError && (
                        <div className="mt-1 max-w-xs text-xs text-red-600 break-words">
                          {d.sync.lastError}
                        </div>
                      )}
                    </td>
                    <td className="p-3 space-y-2">
                      <div className="flex flex-wrap gap-2">
                        <RowActionForm
                          action={toggleDeviceActiveAction}
                          id={d.id}
                          fields={{ active: String(!d.isActive) }}
                          label={d.isActive ? "Deactivate" : "Activate"}
                          confirmMessage={
                            d.isActive
                              ? `Deactivate ${d.name}? The sync worker will stop reading it.`
                              : undefined
                          }
                        />
                        <RowActionForm
                          action={deleteDeviceAction}
                          id={d.id}
                          label="Delete"
                          danger
                          confirmMessage={`Delete ${d.name}? Sync history for this device ID stays in the database, but the device config will be removed.`}
                        />
                      </div>
                      <details>
                        <summary className="cursor-pointer text-xs underline">
                          Edit
                        </summary>
                        <div className="mt-2 max-w-sm">
                          <SimpleForm
                            action={updateDeviceAction}
                            submitLabel="Save"
                            hidden={{ id: d.id }}
                            fields={[
                              { name: "name", label: "Device name", required: true, defaultValue: d.name },
                              { name: "ip", label: "IP address", required: true, defaultValue: d.ip },
                              { name: "port", label: "Port", type: "number", required: true, defaultValue: String(d.port) },
                              { name: "commKey", label: "Comm key", type: "number", required: true, defaultValue: String(d.commKey) },
                            ]}
                          />
                        </div>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}