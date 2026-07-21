import { createClient } from "@/lib/supabase/server";
import { createService, updateService, deleteService } from "./actions";
import type { ServiceRow } from "@/lib/types";

const inputCls =
  "w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900 disabled:bg-gray-50 disabled:text-gray-500";

function ServiceForm({
  service,
  canEdit,
}: {
  service?: ServiceRow;
  canEdit: boolean;
}) {
  const isNew = !service;
  return (
    <form
      action={isNew ? createService : updateService}
      className="grid grid-cols-12 items-end gap-2 border-t border-gray-100 px-4 py-3"
    >
      {service ? <input type="hidden" name="id" value={service.id} /> : null}

      <div className="col-span-12 md:col-span-3">
        {isNew ? (
          <label className="block text-xs font-medium text-gray-500">Service</label>
        ) : null}
        <input
          name="name"
          defaultValue={service?.name ?? ""}
          placeholder="Service name"
          disabled={!canEdit}
          className={inputCls}
        />
      </div>

      <div className="col-span-6 md:col-span-2">
        {isNew ? (
          <label className="block text-xs font-medium text-gray-500">Pricing</label>
        ) : null}
        <select
          name="price_type"
          defaultValue={service?.price_type ?? "fixed"}
          disabled={!canEdit}
          className={inputCls}
        >
          <option value="fixed">Fixed price</option>
          <option value="quote">Call-out + quote</option>
        </select>
      </div>

      <div className="col-span-6 md:col-span-2">
        {isNew ? (
          <label className="block text-xs font-medium text-gray-500">Price / fee ($)</label>
        ) : null}
        <div className="flex gap-1">
          <input
            name="price"
            type="number"
            min={0}
            step="0.01"
            defaultValue={service?.price != null ? String(service.price) : ""}
            placeholder="fixed $"
            disabled={!canEdit}
            className={inputCls}
          />
          <input
            name="callout_fee"
            type="number"
            min={0}
            step="0.01"
            defaultValue={service?.callout_fee != null ? String(service.callout_fee) : ""}
            placeholder="call-out $"
            disabled={!canEdit}
            className={inputCls}
          />
        </div>
      </div>

      <div className="col-span-4 md:col-span-1">
        {isNew ? (
          <label className="block text-xs font-medium text-gray-500">Min</label>
        ) : null}
        <input
          name="duration"
          type="number"
          min={15}
          step="15"
          defaultValue={service?.default_duration_min ?? 60}
          disabled={!canEdit}
          className={inputCls}
        />
      </div>

      <label className="col-span-4 flex items-center gap-1.5 text-xs text-gray-600 md:col-span-1">
        <input
          type="checkbox"
          name="emergency"
          defaultChecked={service?.emergency_eligible ?? false}
          disabled={!canEdit}
          className="h-4 w-4 rounded border-gray-300"
        />
        Emerg.
      </label>

      {service ? (
        <label className="col-span-4 flex items-center gap-1.5 text-xs text-gray-600 md:col-span-1">
          <input
            type="checkbox"
            name="active"
            defaultChecked={service.active}
            disabled={!canEdit}
            className="h-4 w-4 rounded border-gray-300"
          />
          Active
        </label>
      ) : (
        <div className="hidden md:col-span-1 md:block" />
      )}

      {canEdit ? (
        <div className="col-span-12 flex gap-2 md:col-span-2 md:justify-end">
          <button
            type="submit"
            className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800"
          >
            {isNew ? "Add" : "Save"}
          </button>
          {service ? (
            <button
              type="submit"
              formAction={deleteService}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Delete
            </button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { saved, error } = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", user!.id)
    .maybeSingle();
  const canEdit = profile?.role === "admin";

  const { data } = await supabase
    .from("services")
    .select(
      "id, name, category, price_type, price, callout_fee, default_duration_min, emergency_eligible, active",
    )
    .order("name", { ascending: true });
  const services = (data ?? []) as ServiceRow[];

  return (
    <div className="max-w-4xl">
      <h1 className="text-lg font-semibold text-gray-900">Services &amp; pricing</h1>
      <p className="mt-1 text-sm text-gray-500">
        The catalog the agent quotes from. Fixed-price services book at a set
        price; call-out + quote services collect a trip fee now and the job value
        is finalized on site.
      </p>

      {saved ? (
        <div className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
          Services updated.
        </div>
      ) : null}
      {error ? (
        <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}
      {!canEdit ? (
        <div className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700">
          You have read-only access. Only admins can edit services.
        </div>
      ) : null}

      <div className="mt-6 overflow-hidden rounded-lg border border-gray-200 bg-white">
        <div className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-gray-400">
          {services.length} service{services.length === 1 ? "" : "s"}
        </div>
        {services.map((s) => (
          <ServiceForm key={s.id} service={s} canEdit={canEdit} />
        ))}
        {canEdit ? (
          <div className="border-t border-gray-200 bg-gray-50">
            <p className="px-4 pt-3 text-xs font-medium uppercase tracking-wide text-gray-400">
              Add a service
            </p>
            <ServiceForm canEdit={canEdit} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
