#!/bin/sh

DATA_DIR=${DATA_DIR:-./data}

mkdir -p "$DATA_DIR/API"
curl https://beta.gouv.fr/api/v2.6/authors.json -o "$DATA_DIR/API/members.json"
curl https://beta.gouv.fr/api/v2.6/startups.json -o "$DATA_DIR/API/startups.json"
curl https://beta.gouv.fr/api/v2.6/startups_details.json -o "$DATA_DIR/API/startups_details.json"
curl https://beta.gouv.fr/api/v2.6/incubators.json -o "$DATA_DIR/API/incubators.json"

if [ -d "$DATA_DIR/gitscan" ]; then
  git -C "$DATA_DIR/gitscan" pull
else
  git clone https://github.com/betagouv/gitscan --depth=1 "$DATA_DIR/gitscan"
fi

if [ -d "$DATA_DIR/doc.incubateur.net" ]; then
  git -C "$DATA_DIR/doc.incubateur.net" pull
else
  git clone https://github.com/betagouv/doc.incubateur.net-communaute --depth=500 "$DATA_DIR/doc.incubateur.net"
fi


mkdir -p "$DATA_DIR/peertube"
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=animation_beta&sort=-createdAt" -o "$DATA_DIR/peertube/animation_beta.json"
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=lasuite_modedemploi&sort=-createdAt" -o "$DATA_DIR/peertube/lasuite_modedemploi.json"
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=bluehats&sort=-createdAt" -o "$DATA_DIR/peertube/bluehats.json"
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=lasuite&sort=-createdAt" -o "$DATA_DIR/peertube/lasuite.json"
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=grist&sort=-createdAt" -o "$DATA_DIR/peertube/grist.json"
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=designgouv&sort=-createdAt" -o "$DATA_DIR/peertube/designgouv.json"
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=tchap&sort=-createdAt" -o "$DATA_DIR/peertube/tchap.json"
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=datagouvfr&sort=-createdAt" -o "$DATA_DIR/peertube/datagouvfr.json"
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=fabnum.mte&sort=-createdAt" -o "$DATA_DIR/peertube/fabnum.mte.json"
curl "https://tube.numerique.gouv.fr/feeds/videos.json?videoChannelName=ruche_numerique&sort=-createdAt" -o "$DATA_DIR/peertube/ruche_numerique.json"

curl "https://calendar.google.com/calendar/ical/0ieonqap1r5jeal5ugeuhoovlg%40group.calendar.google.com/public/basic.ics" -o "$DATA_DIR/calendar.ics"

mkdir -p "$DATA_DIR/index"

TODAY=$(date +%Y-%m-%d)
jq --arg today "$TODAY" '[.[] | select(.missions[]?.end > $today) | {id, fullname, competences, role, domaine}] | unique_by(.id)' "$DATA_DIR/API/members.json" > "$DATA_DIR/index/members.json"

jq --slurpfile details "$DATA_DIR/API/startups_details.json" '
  [.data[]
   | select(.attributes.phases | map(.name) | any(. == "abandon" or . == "abandon-investigation") | not)
   | {
       id: .id,
       name: .attributes.name,
       description: .attributes.pitch,
       active_member_count: (($details[0][.id].active_members // []) | length)
     }
  ]' "$DATA_DIR/API/startups.json" > "$DATA_DIR/index/startups.json"

jq '[to_entries[] | {id: .key, title: .value.title, contact: .value.contact, website: .value.website, github: .value.github, startup_count: (.value.startups | length)}]' "$DATA_DIR/API/incubators.json" > "$DATA_DIR/index/incubators.json"


cat > "$DATA_DIR/index/phases.txt" << EOF
 - investigation: En investigation (recherche terrain)
 - construction: En construction (lancement du produit)
 - acceleration: En accélération (déploiement du produit)
 - perennisation: En consolidation. Le service est en cours de sortie d'incubation. L'équipe travaille sur les modalités pour opérer le service sur le long-terme.
 - transfere: Transféré. Le service est sorti du programme beta.gouv.fr et est toujours accessible et utilisable pour ses utilisateurs suite à sa sortie.
 - opere: Opéré au sein du réseau. Le service est mature et n'est plus dans une logique d'incubation. Un incubateur ou un opérateur du réseau continue à être impliqué et à suivre l'impact du service.
 - abandon: Arrêté. Le service a été arrêté pendant le programme d'incubation. Il n'est plus accessible pour ses utilisateurs
 - abandon-investigation: Investigation non concluante. L'investigation n'a pas mené à la création d'un service numérique.
EOF

tree -L 2 "$DATA_DIR"

du -hs "$DATA_DIR"
