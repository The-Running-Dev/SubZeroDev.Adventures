import { Component, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import { Panel } from "../components/Panel";

function Failure({ retry }: { retry: () => void }) {
  const { t } = useTranslation("shell");
  return (
    <Panel role="alert">
      <h1>
        {t("screenError", {
          defaultValue: "This screen could not be displayed.",
        })}
      </h1>
      <Button onClick={retry}>{t("retry", { defaultValue: "Retry" })}</Button>
    </Panel>
  );
}
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <Failure retry={() => this.setState({ failed: false })} />
    ) : (
      this.props.children
    );
  }
}
