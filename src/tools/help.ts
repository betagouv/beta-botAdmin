import { config } from "../config.js";

export function buildHelp(): string {
  return buildBotHelp();
}

// OPS-request help, shown by `/help` inside the rooms listed in
// MATRIX_OPS_ROOMS. Content mirrors demandes-ops.md (the espace-membre form).
// Open to everyone, no command-room restriction.
export function buildOpsHelp(): string {
  return `# Faire une demande d'OPS

Les demandes d'OPS passent par un **formulaire dans l'espace membre** (il remplace l'ancien form Airtable). La demande est enregistrée et traitée par l'équipe ops.

## Comment faire

1. Va sur **Services** dans l'[espace membre](https://espace-membre.beta.gouv.fr).
2. Clique sur la carte **Demandes d'OPS**.
3. Choisis le **type de demande**.
4. Remplis les champs qui apparaissent (ils dépendent du type).
5. Si ce n'est pas pour une startup d'État, précise le **projet**.
6. **Envoie**.

Ton identifiant Tchap, ton email et ton nom sont préremplis automatiquement.

## Ce que tu peux demander

| Type de demande | Champs à remplir |
|---|---|
| Création d'app Scalingo | Nom de l'app, Email collaborateur |
| Ressources Clever cloud / OVH / scaleway | Commentaires *(obligatoire)* |
| Création/délégation domaine/zone DNS (OVH) | Handle OVH, Zone DNS |
| Ajouter un record sur domaine OVH (CNAME, A...) | Commentaires *(obligatoire)* |
| Ajout site/membre Matomo | URL du site, Email à associer |
| Ajout team/membre Sentry | URL du site, Email à associer |
| Ajout site sur updown.io | URL à surveiller, Emails à notifier |
| Création compte Tally | Commentaires *(obligatoire)* |
| Mon email bounce | Commentaires *(obligatoire)* |
| Autre | Commentaires |

Chaque type a aussi un champ **Commentaires** (libre).

> Si ton type de demande n'est pas dans la liste : pose la question directement ici, sur le canal \`~Demandes-OPS\`.`;
}

function buildBotHelp(): string {
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
| \`/salon list\` | tout le monde | Liste les salons, groupés par espace |
| \`/salon create <nom>\` | tout le monde | Crée un salon chiffré, t'y invite, et le rattache à l'espace géré |
| \`/salon create <nom> <espace>\` | tout le monde | Idem, mais rattache le salon au sous-espace **<espace>** (dernier mot = nom **ou** ID d'un sous-espace existant) |
| \`/salon delete <nom>\` | modérateur+ du salon ciblé | Ferme le salon de l'espace géré : détache + expulse les membres + le bot quitte |
| \`/salon delete <nom> <espace>\` | modérateur+ du salon ciblé | Idem mais cible le salon dans le sous-espace **<espace>** (lève l'ambiguïté) |

### \`/espace\` — gestion des sous-espaces
- **Où** : ${cmdWhere}
- **Espace géré** : ${managedSpace}

| Sous-commande | Qui | Description |
|---|---|---|
| \`/espace list\` | tout le monde | Liste les sous-espaces de l'espace géré |
| \`/espace create <nom>\` | tout le monde | Crée un sous-espace et le rattache à l'espace géré |
| \`/espace delete <nom>\` | modérateur+ de l'espace | Supprime le(s) sous-espace(s) de ce nom (détache + expulse + le bot quitte) |

## Si quelque chose ne marche pas

- Commande refusée dans un salon → utilise-la dans ${cmdWhere}
- Réponse "permission denied" sur \`/emails\` → mon compte DiMail n'a pas les droits, contacte l'admin
- Pas de réaction du tout → vérifie que ton message commence par \`/\` (en salon, \`@mentionne\`-moi)`;
}
