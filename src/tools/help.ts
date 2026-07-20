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
    ? config.matrix.commandRoomsUrl
      ? `[${config.matrix.commandRoomsLabel}](${config.matrix.commandRoomsUrl})`
      : `\`${config.matrix.commandRoomsLabel}\``
    : cmdRooms.length > 0
      ? cmdRooms.map((r) => `\`${r}\``).join(", ")
      : "(aucune restriction, partout)";

  const dimailDomain =
    config.dimail.domain || "(non configuré, DIMAIL_DOMAIN vide)";

  return `# Aide betabot

Je suis un bot **à commandes** : je ne discute pas en langage naturel. Je ne réagis qu'aux commandes ci-dessous.

## Comment me solliciter

Dans ${cmdWhere}, **mentionne-moi suivi d'une commande**, par exemple \`@betabot /help\`.

> ⚠️ Je ne discute pas en langage naturel. Un texte normal (en MP ou en \`@mention\`, sans commande) ne renvoie qu'un message générique, et sans \`@\` ni \`/\` dans un salon je reste silencieux.

## Commandes slash

### \`/help\` (ou \`/aide\`)
- **Effet** : affiche cette aide — toutes les commandes et leurs paramètres.

### \`/emails\` — gestion des mailing lists
- **Domaine par défaut** : ${dimailDomain}

| Sous-commande | Description |
|---|---|
| \`@betabot /emails\` ou \`@betabot /emails help\` | Affiche cette aide /emails |
| \`@betabot /emails create <liste> <email>\` | Crée une nouvelle liste avec un propriétaire |
| \`@betabot /emails list <liste>\` | Affiche les membres d'une liste |
| \`@betabot /emails join <liste> <email>\` | Ajoute un membre à une liste |
| \`@betabot /emails leave <liste> <email>\` | Retire un membre d'une liste |

**Format \`<liste>\`** :
- Nom simple (\`cartobio\`) → résolu en \`cartobio@<domaine par défaut>\`
- Adresse complète (\`contact@beta.gouv.fr\`)

> ℹ️ On ne gère que les adresses en \`beta.gouv.fr\`.

**Exemples** :
- \`@betabot /emails join cartobio jean.louis@beta.gouv.fr\`
- \`@betabot /emails join contact@beta.gouv.fr jean.louis@beta.gouv.fr\`

### \`/salon\` — gestion des salons d'un espace

| Sous-commande | Qui | Description |
|---|---|---|
| \`@betabot /salon list\` | tout le monde | Liste les salons, groupés par espace |
| \`@betabot /salon create <nom>\` | tout le monde | Crée un salon chiffré, t'y invite, et le rattache à l'espace géré |
| \`@betabot /salon create <nom> --clair\` | tout le monde | Idem mais salon **non chiffré** (le chiffrement ne peut pas être retiré ensuite) |
| \`@betabot /salon create <nom> <espace>\` | tout le monde | Idem, mais rattache le salon au sous-espace **<espace>** (nom **ou** ID). Nom avec espaces : entre guillemets, ex. \`@betabot /salon create <nom> "Pole Tech"\` |
| \`@betabot /salon create <nom> --startup <startup> [--role <role>]\` | tout le monde | Idem, et **invite** les membres de la startup **<startup>** dans le salon créé (\`--role\` restreint à ce rôle) |
| \`@betabot /salon delete <nom>\` | modérateur+ du salon ciblé | Ferme le salon de l'espace géré : détache + expulse les membres + le bot quitte |
| \`@betabot /salon delete <nom> <espace>\` | modérateur+ du salon ciblé | Idem mais cible le salon dans le sous-espace **<espace>** (lève l'ambiguïté ; espace avec espaces = entre guillemets) |

### \`/espace\` — gestion des sous-espaces

| Sous-commande | Qui | Description |
|---|---|---|
| \`@betabot /espace list\` | tout le monde | Liste les sous-espaces de l'espace géré |
| \`@betabot /espace list <espace>\` | tout le monde | Liste les sous-espaces d'un sous-espace (nom **ou** ID, à n'importe quelle profondeur) |
| \`@betabot /espace create <nom>\` | tout le monde | Crée un sous-espace et le rattache à l'espace géré |
| \`@betabot /espace create <nom> <espace-parent>\` | membre de l'espace parent | Crée un sous-espace **imbriqué** dans **<espace-parent>** (nom **ou** ID). Nom avec espaces : entre guillemets, ex. \`@betabot /espace create <nom> "Pole Tech"\` |
| \`@betabot /espace delete <nom>\` | utilisateur autorisé, en MP | Supprime un sous-espace **vide** (refusé s'il contient encore des salons ou sous-espaces) |

## Si quelque chose ne marche pas

- Commande refusée dans un salon → utilise-la dans ${cmdWhere}
- Réponse "permission denied" sur \`/emails\` → mon compte DiMail n'a pas les droits, contacte l'admin
- Pas de réaction du tout → vérifie que ton message commence par \`/\` (en salon, \`@mentionne\`-moi)`;
}
