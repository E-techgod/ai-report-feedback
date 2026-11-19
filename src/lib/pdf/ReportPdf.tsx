// Explicit React import: the node test runner (tsx) compiles JSX with the classic transform.
import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type * as ReactPdf from '@react-pdf/renderer';
import type { FinalReport } from '../final-report';
import { buildReportContent, type AreaContent, type ReportContent } from '../report-content';

/**
 * Server-side PDF of the finalized report. Rendered from buildReportContent(report) — the same
 * content object the web view and the email use — never from browser state.
 */
const C = {
  ink: '#162a20',
  muted: '#63756a',
  line: '#e1e8df',
  forest: '#143b2c',
  gold: '#be925a',
  soft: '#f4f3ee',
  amber: '#9a6626',
  amberBg: '#fbf0df',
  greenBg: '#e6f2ea',
};

function loadLogo(): Buffer | null {
  try {
    return readFileSync(path.join(process.cwd(), 'public', 'images', 'quiron-logo.png'));
  } catch {
    return null;
  }
}

/**
 * @react-pdf/renderer is ESM-only, so it is loaded with a dynamic import (works from CJS and ESM,
 * and keeps it out of the client bundle). The document is built inside this factory.
 */
function buildDocument(r: typeof ReactPdf, c: ReportContent, logo: Buffer | null) {
  const { Document, Font, Image, Link, Page, StyleSheet, Text, View } = r;
  Font.registerHyphenationCallback((word) => [word]);
  const styles = StyleSheet.create({
    page: {
      paddingTop: 84,
      paddingBottom: 56,
      paddingHorizontal: 42,
      fontFamily: 'Helvetica',
      fontSize: 10,
      color: C.ink,
      lineHeight: 1.45,
    },
    header: {
      position: 'absolute',
      top: 24,
      left: 42,
      right: 42,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      borderBottomWidth: 1,
      borderBottomColor: C.line,
      paddingBottom: 10,
    },
    logo: { width: 82, height: 36 },
    brandText: { fontSize: 8, letterSpacing: 1.2, color: C.muted, textTransform: 'uppercase' },
    footer: {
      position: 'absolute',
      bottom: 24,
      left: 42,
      right: 42,
      flexDirection: 'row',
      justifyContent: 'space-between',
      fontSize: 8,
      color: C.muted,
    },
    eyebrow: {
      fontSize: 8,
      letterSpacing: 1.4,
      color: C.gold,
      textTransform: 'uppercase',
      marginBottom: 6,
    },
    h1: {
      fontSize: 24,
      fontFamily: 'Helvetica-Bold',
      color: C.forest,
      lineHeight: 1.15,
      marginBottom: 8,
    },
    lead: { fontSize: 11, color: C.muted, marginBottom: 10 },
    meta: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
      fontSize: 8.5,
      color: C.muted,
      marginBottom: 14,
    },
    scores: { flexDirection: 'row', gap: 12, marginBottom: 6 },
    scoreCard: { flex: 1, borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: 12 },
    scoreLabel: {
      fontSize: 8,
      letterSpacing: 1,
      color: C.muted,
      textTransform: 'uppercase',
      marginBottom: 4,
    },
    scoreNumber: { fontSize: 30, fontFamily: 'Helvetica-Bold', color: C.forest },
    scoreOf: { fontSize: 13, color: C.muted },
    level: {
      fontSize: 9,
      fontFamily: 'Helvetica-Bold',
      color: C.amber,
      backgroundColor: C.amberBg,
      paddingVertical: 3,
      paddingHorizontal: 7,
      borderRadius: 8,
      alignSelf: 'flex-start',
      marginTop: 4,
    },
    levelGreen: { color: C.forest, backgroundColor: C.greenBg },
    barTrack: { height: 6, backgroundColor: C.line, borderRadius: 3, marginTop: 8 },
    barFill: { height: 6, backgroundColor: C.gold, borderRadius: 3 },
    scoreSub: { fontSize: 9, color: C.muted, marginTop: 4 },
    secHeader: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      marginTop: 20,
      marginBottom: 8,
    },
    secNumber: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: C.gold },
    h2: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: C.forest },
    secSub: { fontSize: 9.5, color: C.muted },
    panel: { backgroundColor: C.soft, borderRadius: 6, padding: 12, marginBottom: 8 },
    h3: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: C.forest, marginBottom: 4 },
    signals: { flexDirection: 'row', gap: 8, marginTop: 4 },
    signal: { flex: 1, backgroundColor: '#fff', borderRadius: 4, padding: 8 },
    signalLabel: { fontSize: 7.5, letterSpacing: 0.8, color: C.muted, textTransform: 'uppercase' },
    signalValue: { fontSize: 10.5, fontFamily: 'Helvetica-Bold', marginTop: 2 },
    small: { fontSize: 8, color: C.muted },
    summary: {
      borderLeftWidth: 3,
      borderLeftColor: C.gold,
      paddingLeft: 10,
      marginTop: 4,
      fontSize: 10.5,
    },
    areas: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    area: { width: '48.8%', borderWidth: 1, borderColor: C.line, borderRadius: 6, padding: 10 },
    areaTop: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 6,
      marginBottom: 3,
    },
    chip: {
      fontSize: 7.5,
      color: C.amber,
      backgroundColor: C.amberBg,
      paddingVertical: 2,
      paddingHorizontal: 6,
      borderRadius: 7,
    },
    chipGreen: { color: C.forest, backgroundColor: C.greenBg },
    priority: {
      flexDirection: 'row',
      gap: 10,
      borderWidth: 1,
      borderColor: C.line,
      borderRadius: 6,
      padding: 10,
      marginBottom: 8,
    },
    rank: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: C.forest,
      color: '#fff',
      textAlign: 'center',
      paddingTop: 5,
      fontSize: 10,
      fontFamily: 'Helvetica-Bold',
    },
    bold: { fontFamily: 'Helvetica-Bold' },
    context: { marginTop: 5, backgroundColor: C.soft, borderRadius: 4, padding: 7, fontSize: 9.5 },
    step: {
      flexDirection: 'row',
      gap: 10,
      marginBottom: 6,
      borderLeftWidth: 2,
      borderLeftColor: C.gold,
      paddingLeft: 9,
    },
    cta: { backgroundColor: C.forest, color: '#fff', borderRadius: 8, padding: 16, marginTop: 14 },
    ctaTitle: { fontSize: 13, fontFamily: 'Helvetica-Bold', color: '#fff', marginBottom: 4 },
    ctaText: { fontSize: 9.5, color: '#dfe9e2', marginBottom: 8 },
    ctaButton: {
      backgroundColor: C.gold,
      color: '#fff',
      fontFamily: 'Helvetica-Bold',
      fontSize: 10,
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 4,
      alignSelf: 'flex-start',
      textDecoration: 'none',
    },
    transparency: {
      marginTop: 14,
      borderWidth: 1,
      borderColor: C.line,
      borderRadius: 6,
      padding: 10,
      fontSize: 9,
      color: C.muted,
    },
    legal: { marginTop: 10, fontSize: 8, color: C.muted },
  });

  function SectionHeader({ num, title, sub }: { num: string; title: string; sub: string }) {
    return (
      <View style={styles.secHeader} wrap={false} minPresenceAhead={60}>
        <Text style={styles.secNumber}>{num}</Text>
        <View>
          <Text style={styles.h2}>{title}</Text>
          <Text style={styles.secSub}>{sub}</Text>
        </View>
      </View>
    );
  }

  function Areas({ areas }: { areas: AreaContent[] }) {
    return (
      <View style={styles.areas}>
        {areas.map((a) => (
          <View key={a.id} style={styles.area} wrap={false}>
            <View style={styles.areaTop}>
              <Text style={[styles.h3, { flex: 1, marginBottom: 0 }]}>{a.title}</Text>
              <Text style={a.solid ? [styles.chip, styles.chipGreen] : styles.chip}>
                {a.statusLabel}
              </Text>
            </View>
            <Text>{a.description}</Text>
            <Text style={[styles.small, { marginTop: 4 }]}>{a.countLabel}</Text>
          </View>
        ))}
      </View>
    );
  }

  function ReportPdf() {
    return (
      <Document
        title={`Diagnóstico patrimonial Quirón`}
        author="Quirón Arquitectos Financieros"
        language="es-MX"
      >
        <Page size="A4" style={styles.page}>
          <View style={styles.header} fixed>
            {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image is not a DOM img */}
            {logo ? <Image style={styles.logo} src={{ data: logo, format: 'png' }} /> : <Text />}
            <Text style={styles.brandText}>{c.brand}</Text>
          </View>
          <View style={styles.footer} fixed>
            <Text>QUIRÓN · PROTECCIÓN PATRIMONIAL</Text>
            <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
          </View>

          <View>
            <Text style={styles.eyebrow}>{c.hero.eyebrow}</Text>
            <Text style={styles.h1}>{c.hero.title}</Text>
            <Text style={styles.lead}>{c.hero.lead}</Text>
            <View style={styles.meta}>
              {c.hero.meta.map((m) => (
                <Text key={m}>{m}</Text>
              ))}
            </View>
            <View style={styles.scores} wrap={false}>
              <View style={styles.scoreCard}>
                <Text style={styles.scoreLabel}>{c.hero.score.label}</Text>
                <Text style={styles.scoreNumber}>{c.hero.score.value}</Text>
                <Text
                  style={
                    c.hero.score.levelTone === 'high'
                      ? [styles.level, styles.levelGreen]
                      : styles.level
                  }
                >
                  {c.hero.score.levelLabel}
                </Text>
                <View style={styles.barTrack}>
                  <View style={[styles.barFill, { width: c.hero.score.value }]} />
                </View>
              </View>
              <View style={styles.scoreCard}>
                <Text style={styles.scoreLabel}>{c.hero.weak.label}</Text>
                <Text style={styles.scoreNumber}>
                  {c.hero.weak.value} <Text style={styles.scoreOf}>{c.hero.weak.of}</Text>
                </Text>
                <Text style={styles.scoreSub}>{c.hero.weak.sub}</Text>
              </View>
            </View>
          </View>

          <SectionHeader num={c.executive.num} title={c.executive.title} sub={c.executive.sub} />
          <View style={styles.panel} wrap={false}>
            <Text style={styles.h3}>{c.executive.panelTitle}</Text>
            <View style={styles.signals}>
              {c.executive.signals.map((s) => (
                <View key={s.label} style={styles.signal}>
                  <Text style={styles.signalLabel}>{s.label}</Text>
                  <Text style={styles.signalValue}>{s.value}</Text>
                  <Text style={styles.small}>{s.small}</Text>
                </View>
              ))}
            </View>
          </View>
          <Text style={styles.summary}>{c.executive.summaryText}</Text>

          <SectionHeader num={c.personal.num} title={c.personal.title} sub={c.personal.sub} />
          <Areas areas={c.personal.areas} />

          <SectionHeader num={c.business.num} title={c.business.title} sub={c.business.sub} />
          <Areas areas={c.business.areas} />

          <SectionHeader num={c.priorities.num} title={c.priorities.title} sub={c.priorities.sub} />
          {c.priorities.empty ? (
            <View style={styles.panel}>
              <Text style={styles.h3}>{c.priorities.empty.title}</Text>
              <Text>{c.priorities.empty.text}</Text>
            </View>
          ) : (
            c.priorities.items.map((p) => (
              <View key={p.themeId} style={styles.priority} wrap={false}>
                <Text style={styles.rank}>{p.rank}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.h3}>{p.title}</Text>
                  <Text>
                    <Text style={styles.bold}>{p.findingLabel}</Text> {p.finding}
                  </Text>
                  <Text>
                    <Text style={styles.bold}>{p.actionLabel}</Text> {p.action}
                  </Text>
                  <Text style={styles.context}>{p.context}</Text>
                </View>
              </View>
            ))
          )}

          <SectionHeader num={c.plan.num} title={c.plan.title} sub={c.plan.sub} />
          {c.plan.steps.map((s) => (
            <View key={s.title} style={styles.step} wrap={false}>
              <View style={{ flex: 1 }}>
                <Text style={styles.small}>{s.stage}</Text>
                <Text style={styles.h3}>{s.title}</Text>
                <Text>{s.text}</Text>
              </View>
            </View>
          ))}

          <View style={styles.cta} wrap={false}>
            <Text style={styles.ctaTitle}>{c.cta.title}</Text>
            <Text style={styles.ctaText}>{c.cta.text}</Text>
            {c.cta.url ? (
              <Link src={c.cta.url} style={styles.ctaButton}>
                {c.cta.buttonLabel}
              </Link>
            ) : (
              <>
                <Text style={[styles.ctaButton, { opacity: 0.55 }]}>{c.cta.buttonLabel}</Text>
                <Text style={[styles.ctaText, { marginTop: 6, marginBottom: 0 }]}>
                  {c.cta.unavailableNote}
                </Text>
              </>
            )}
          </View>

          <View style={styles.transparency} wrap={false}>
            <Text style={styles.h3}>{c.transparency.title}</Text>
            {c.transparency.paragraphs.map((p) => (
              <Text key={p}>{p}</Text>
            ))}
          </View>
          <Text style={styles.legal}>{c.legal}</Text>
        </Page>
      </Document>
    );
  }

  return <ReportPdf />;
}

/** Renders the PDF for a finalized report. Deterministic content; only the layout engine varies. */
export async function renderReportPdf(report: FinalReport): Promise<Buffer> {
  const r = await import('@react-pdf/renderer');
  return r.renderToBuffer(buildDocument(r, buildReportContent(report), loadLogo()));
}
