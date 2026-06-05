import { config } from "../config.js";

export function buildHelp(): string {
  const cmdRooms = config.matrix.commandRooms;
  const cmdWhere = config.matrix.commandRoomsLabel
    ? `\`${config.matrix.commandRoomsLabel}\``
    : cmdRooms.length > 0
      ? cmdRooms.map((r) => `\`${r}\``).join(", ")
      : "(aucune restriction, partout)";

  const dimailRooms = config.matrix.dimailRooms;
  const dimailWhere =
    dimailRooms.length > 0
      ? config.matrix.commandRoomsLabel &&
        dimailRooms.length === cmdRooms.length &&
        dimailRooms.every((r) => cmdRooms.includes(r))
        ? `\`${config.matrix.commandRoomsLabel}\``
        : dimailRooms.map((r) => `\`${r}\``).join(", ")
      : "(désactivés — aucune room listée dans MATRIX_DIMAIL_ROOMS)";

  const dimailDomain =
    config.dimail.domain || "(non configuré, DIMAIL_DOMAIN vide)";

  const managedSpace =
    config.matrix.managedSpace || "(désactivé — MATRIX_MANAGED_SPACE vide)";

  return `# Aide betabot

Je suis un bot **à commandes** : je ne discute pas en langage naturel. Je ne réagis qu'aux commandes ci-dessous.

## Comment me solliciter

- **En MP** ou **en \`@mention\`** avec un texte normal → je renvoie un message générique (je ne réponds pas en langage naturel).
- **Les commandes** se lancent dans ${cmdWhere}, en tapant une commande qui commence par \`/\`.
- Sans \`@\` ni \`/\` dans un salon, je reste silencieux.

## Commandes slash

### \`/help\` (ou \`/aide\`)
- **Où** : ${cmdWhere}
- **Effet** : affiche cette aide — toutes les commandes et leurs paramètres.

### \`/emails\` — gestion des mailing lists
- **Où** : ${dimailWhere}
- **Domaine par défaut** : ${dimailDomain}

| Sous-commande | Description |
|---|---|
| \`/emails\` ou \`/emails help\` | Affiche cette aide /emails |
| \`/emails create <liste> <email>\` | Crée une nouvelle liste avec un propriétaire |
| \`/emails list <liste>\` | Affiche les membres d'une liste |
| \`/emails join <liste> <email>\` | Ajoute un membre à une liste |
| \`/emails leave <liste> <email>\` | Retire un membre d'une liste |

**Format \`<liste>\`** :
- Nom simple (\`cartobio\`) → résolu en \`cartobio@<domaine par défaut>\`
- Adresse complète (\`contact@covoiturage.beta.gouv.fr\`) → sous-domaine

**Exemples** :
- \`/emails join cartobio jean.louis@beta.gouv.fr\`
- \`/emails join contact@covoiturage.beta.gouv.fr jean.louis@beta.gouv.fr\`

### \`/salon\` — gestion des salons d'un espace
- **Où** : ${cmdWhere}
- **Espace géré** : ${managedSpace}

| Sous-commande | Qui | Description |
|---|---|---|
| \`/salon list\` | tout le monde | Liste les salons de l'espace géré |
| \`/salon create <nom>\` | tout le monde | Crée un salon chiffré, t'y invite, et le rattache à l'espace |
| \`/salon delete <nom>\` | modérateur+ du salon ciblé | Ferme le salon : détache de l'espace + expulse les membres + le bot quitte |

## Si quelque chose ne marche pas

- Commande refusée dans un salon → utilise-la dans ${cmdWhere}
- Réponse "permission denied" sur \`/emails\` → mon compte DiMail n'a pas les droits, contacte l'admin
- Pas de réaction du tout → vérifie que ton message commence par \`/\` (en salon, \`@mentionne\`-moi)`;
}
