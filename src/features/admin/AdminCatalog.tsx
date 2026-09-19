import { useTranslation } from "react-i18next";
import type { AdminPanelProps } from "./types";
import type { useAdminController } from "./useAdminController";
export function AdminCatalog({
  demo,
  adminStatus,
}: AdminPanelProps & ReturnType<typeof useAdminController>) {
  const { t } = useTranslation("admin");
  return (
    <>
      <section className="admin-block">
        <h2 className="admin-heading">{t("catalog")}</h2>
        <div className="admin-table-scroll" tabIndex={0}>
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">{t("campaign")}</th>
                <th scope="col">{t("campaignTitle")}</th>
                <th scope="col">{t("kind")}</th>
                <th scope="col">{t("version")}</th>
                <th scope="col">{t("endings")}</th>
              </tr>
            </thead>
            <tbody>
              {demo.catalog.map((campaign) => (
                <tr key={campaign.campaignId}>
                  <td>
                    <code>{campaign.campaignId}</code>
                  </td>
                  <td>{campaign.title}</td>
                  <td>
                    {t(`library:kinds.${campaign.kindId}`, {
                      defaultValue: campaign.kindId,
                    })}
                  </td>
                  <td>
                    <code>{campaign.version}</code>
                  </td>
                  <td>{campaign.endingCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {demo.apiUrl && adminStatus && adminStatus.extensions.length > 0 && (
        <section className="admin-block">
          <h2 className="admin-heading">{t("extensions")}</h2>
          <div className="admin-table-scroll" tabIndex={0}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">{t("extension")}</th>
                  <th scope="col">{t("extends")}</th>
                </tr>
              </thead>
              <tbody>
                {adminStatus.extensions.map((extension) => (
                  <tr key={extension.id}>
                    <td>
                      <code>{extension.id}</code>
                    </td>
                    <td>
                      <code>{extension.extends}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
