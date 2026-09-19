import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="play-load-error" role="alert">
        <h1>This screen could not be displayed.</h1>
        <button
          className="cabinet-button"
          onClick={() => this.setState({ failed: false })}
        >
          Retry
        </button>
      </section>
    );
  }
}
