# Gobernanza

## Modelo actual

Ley Abierta utiliza un modelo de **mantenedor principal** (BDFL — *Benevolent Dictator for Life*). Esto significa que hay una persona que toma las decisiones finales sobre la dirección del proyecto.

**Mantenedor principal:** Alejandro Martinez ([@lyricalstring](https://github.com/LyricalString)) — alex@konar.es

### Qué implica

- El mantenedor principal revisa y aprueba los pull requests
- Las decisiones de arquitectura, diseño y roadmap las toma el mantenedor, consultando con la comunidad cuando es posible
- Cualquier contribución que esté alineada con la [visión del proyecto](VISION.md) es bienvenida

### Cómo se toman las decisiones

1. **Contribuciones de código**: Si un PR está alineado con la visión y pasa las comprobaciones (tests, linting), se mergea
2. **Nuevas funcionalidades**: Se discuten primero en [GitHub Discussions](../../discussions) o en un issue antes de implementarse
3. **Cambios en la visión o principios**: Solo el mantenedor principal puede modificar [VISION.md](VISION.md)

## Evolución futura

A medida que la comunidad crezca, la gobernanza evolucionará hacia un modelo de **consenso**:

- Las propuestas se publicarán como discussions o issues
- Si hay consenso y está alineado con la visión, se aprueba
- Se podrán añadir **mantenedores de área** (web, API, pipeline, datos) que tengan autonomía para revisar y mergear en su ámbito
- Los cambios en la visión o principios fundamentales siempre requerirán una discusión abierta

## Cómo convertirse en mantenedor

No hay un proceso formal todavía. Si contribuyes de forma consistente y demuestras entender la visión del proyecto, se te invitará a ser mantenedor de área.
