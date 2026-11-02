import type { AdminPanelProps } from "../features/admin/types";
import { useAdminController } from "../features/admin/useAdminController";
import { AdminOverview } from "../features/admin/AdminOverview";
import { AdminSources } from "../features/admin/AdminSources";
import { AdminQueue } from "../features/admin/AdminQueue";
import { AdminCatalog } from "../features/admin/AdminCatalog";
import { AdminCaptures } from "../features/admin/AdminCaptures";
export function AdminPanel(props: AdminPanelProps) {
  const controller = useAdminController(props);
  return (
    <section
      className="feature-page archive admin"
      aria-labelledby="admin-title"
    >
      <AdminOverview {...props} {...controller} />
      <AdminSources {...props} {...controller} />
      <AdminQueue {...props} {...controller} />
      <AdminCatalog {...props} {...controller} />
      <AdminCaptures demo={props.demo} />
    </section>
  );
}
