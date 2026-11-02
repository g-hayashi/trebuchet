# Specification Quality Checklist: 定額法・一括償却資産・開業費の償却

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-11-01
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- ADR 0005・INV-21・INV-23・Constitution への参照は、既存の規則を引き継ぐ根拠として残した（実装の指定ではない）。
- 一括償却資産の端数の寄せ方は plan に委ねた（Assumptions）。
- 範囲の判断（定率法・旧定額法・中古の簡便法・売却の譲渡所得の計算・開業費以外の繰延資産は範囲外、開業費は任意償却で 60 か月は目安）は既定値を置いた。変えたい場合は `/speckit-clarify` で確かめる。
- 2026-11-01（plan の後、利用者の回答 research R16）: 一括償却の開始を「事業の用に供した年度」に、売却を「除却の種類で選び、未償却残高を事業主貸へ振り替える」に、変更の制限を「どの年度でも有効な償却の仕訳があれば計算に効く項目を変えられない（少額の特例の資産を含む）」に直した（US1 シナリオ7、US2、Edge Cases、FR-009、FR-010、Key Entities、Assumptions）。
