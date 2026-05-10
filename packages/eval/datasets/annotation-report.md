# Article-level annotation report

**Run:** 2026-05-10T11:55:05.099Z
**Model:** qwen3.6 (NaN)
**Input:** packages/eval/datasets/seeds/v3-seeds-after-heldout.json (64 questions)

## Gate metric (question-level)

- questions evaluated: **64**
- questions with ≥1 article picked from any expectedNorm: **49**
- **question hit rate: 76.6%** (target: ≥90%)
- gate: ❌ FAIL

## Pair-level (diagnostic)

- (question × norm) pairs evaluated: **80**
- pairs with ≥1 article picked: **57**
- pairs with 0 articles picked: **23**
- norms missing from DB: **0**
- pair hit rate: 71.3%
- (pair misses can be legitimate when human GT is over-generous about multi-norm answers)

## Throughput

- total LLM time: 333.9s
- avg per pair: 4173ms
- tokens in / out: 881718 / 8596

## Misses (review these)

- `q_6c76d448` (citizen) — BOE-A-2023-12203
  Q: el casero me sube el alquiler de golpe
- `q_fbbcdca7` (citizen) — BOE-A-2015-11430
  Q: me echaron del trabajo estando embarazada
- `q_8b614d7e` (citizen) — BOE-A-2015-11430
  Q: permiso para ir a la boda de mi hermano
- `q_ba7b07d3` (citizen) — BOE-A-2015-11430
  Q: se ha muerto mi padre cuántos días tengo de permiso
- `q_ac66f4f0` (citizen) — BOE-A-1889-4763
  Q: cómo se reparte la casa cuando te divorcias
- `q_6d82817b` (citizen) — BOE-A-1889-4763
  Q: incapacitar a un familiar mayor con demencia
- `q_8bc73e67` (citizen) — BOE-A-2007-20555
  Q: garantía de un producto que se rompió a los meses
- `q_7ad94761` (citizen) — BOE-A-1995-25444
  Q: atropellé a alguien sin querer
- `q_b8f11357` (formal) — BOE-A-2015-11430
  Q: ¿Cuánto dura la baja por paternidad?
- `q_ae2fb094` (formal) — BOE-A-2015-11430
  Q: ¿Cuánto es el salario mínimo interprofesional?
- `q_a7699ae1` (formal) — BOE-A-2015-11430
  Q: Si me quedo embarazada, ¿qué derechos laborales tengo y qué prestaciones puedo cobrar?
- `q_7a641129` (formal) — BOE-A-2006-20764
  Q: ¿Puedo deducirme el alquiler en la declaración de la renta como inquilino?
- `q_7a641129` (formal) — BOE-A-1994-26003
  Q: ¿Puedo deducirme el alquiler en la declaración de la renta como inquilino?
- `q_7cb7a8c6` (formal) — BOE-A-2015-11430
  Q: ¿Ha cambiado la duración de la baja por paternidad? ¿Cuánto era antes?
- `q_ac206855` (formal) — BOE-A-2018-16673
  Q: ¿Puedo grabar a mi jefe sin que lo sepa?
- `q_68e353c5` (formal) — BOE-A-2007-13409
  Q: Soy autónomo, trabajo desde casa, y mi casero quiere echarme. ¿El contrato de alquiler protege también mi negocio?
- `q_1f7ad200` (formal) — BOE-A-1994-26003
  Q: ¿Puede mi casero entrar en mi piso sin mi permiso?
- `q_bdfa3635` (formal) — BOE-A-1994-26003
  Q: Si firmé mi contrato de alquiler en 2015, ¿qué ley me aplica, la de antes o la de ahora?
- `q_bdfa3635` (formal) — BOE-A-2023-12203
  Q: Si firmé mi contrato de alquiler en 2015, ¿qué ley me aplica, la de antes o la de ahora?
- `q_9341fa21` (formal) — BOE-A-1978-31229
  Q: ¿Cuántas veces se ha reformado la Constitución española?
- `q_5ac497c3` (formal) — BOE-A-2018-9774
  Q: ¿Qué dice la ley de vivienda de las Illes Balears sobre el precio del alquiler?
- `q_900dd633` (formal) — BOE-A-2015-11430
  Q: ¿Pueden obligarme a hacer un test de drogas en el trabajo?
- `q_900dd633` (formal) — BOE-A-1978-31229
  Q: ¿Pueden obligarme a hacer un test de drogas en el trabajo?
