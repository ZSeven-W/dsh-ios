/**
 * Last-resort guard around every dsh-ios conversation card. A throwing slot
 * component must never take down the conversation, so each registered view is
 * wrapped in this boundary and renders a static fallback card instead.
 */

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { CARD_STYLES } from './card-styles.js'

interface SimCardBoundaryProps {
  children: ReactNode
}

interface SimCardBoundaryState {
  failed: boolean
}

export class SimCardBoundary extends Component<SimCardBoundaryProps, SimCardBoundaryState> {
  constructor(props: SimCardBoundaryProps) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError(): SimCardBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('dsh-ios: simulator card render failed', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <section style={CARD_STYLES.card} data-tool="dsh-ios" data-state="unavailable">
        <div style={CARD_STYLES.head}><span>iOS Simulator</span></div>
        <div style={CARD_STYLES.body}>
          <div style={CARD_STYLES.fallback} role="alert">
            <strong style={CARD_STYLES.fallbackTitle}>stream not available</strong>
            <span style={CARD_STYLES.muted}>The simulator card failed to render.</span>
          </div>
        </div>
      </section>
    )
  }
}
