'use strict';

// Two-word print codes, e.g. "maple tractor", handwritten on thank-you print cards.
//
// The list is chosen to survive handwriting and phone keyboards: plain lowercase
// letters, 4–9 characters, everyday words with one obvious spelling. Left out on
// purpose: homophones (pear/pair, beach/beech), words spelt differently in AU and US
// (harbour/harbor, yoghurt/yogurt), silent letters (knight, lamb), brand names,
// body parts, and anything that could pair into something unkind.

const crypto = require('crypto');

const RAW = `
acorn album almond alpine amber anchor anvil apple apricot apron arcade arrow aspen atlas
attic aurora autumn avenue badge bagel bagpipe baker balcony ballet balloon bamboo banana
banjo banksia banner barley barn barrel basil basin basket beacon beaker beanie beetle bench
bicycle bilby billabong biplane biscuit bison blanket blender blimp blossom bobbin bobcat bongo
bonnet bookcase boomerang bottle boulder bracelet bracket bramble branch breeze brick bridge
brolga bronze brook broom brownie bubble bucket buckle budgie buffalo bugle builder bulldog
bundle bungalow burger burrow bushland butter button cabbage cabin cabinet cable cactus camel
camera canal canary candle candy canoe canvas canyon captain caravan caramel cargo carpet
carrot cartoon cashew castle cattle cedar cello chalk chapel cheddar cheese cheetah cherry
chess chestnut chime chimney chisel chorus chutney cider cinema circus citrus clarinet cliff
clipboard clock cloud clover cobalt cockatoo cocoa coconut coffee comet compass cookie copper
coral corner cosmos costume cottage cotton cowboy coyote cracker crane crater crayon creek
cricket crimson crown crumble crumpet crystal cupcake curtain cushion custard dairy daisy damper
dancer delta denim diamond dingo dinner diver dolphin domino donkey doodle doorbell dove dragon
drizzle drummer dugong dumpling dusk eagle easel echo eclipse elephant ember emerald engine
envelope eraser fable factory fairy falcon farmer feather fennel ferret ferry festival fiddle
finch fishbowl flag flame flamingo flannel flask flipper florist flute folder football forest
forklift fossil fountain freckle frog frost fudge funnel gadget galah galaxy garden gardener
garlic gazebo gazelle gecko gelato gemstone ginger glider globe glove goat goblet golden golf
gondola gopher grain granite granola grape gravel gravy grocer guava guitar gumboot gumnut
gumtree gymnast hammer hammock hamster harp harvest hawk haystack hazel heather hedge helmet
heron highway hiker hinge hobby hockey honey hoodie horizon hornet hotel hound iceberg igloo
iguana indigo inkwell island ivory jacaranda jacket jaguar jasmine jelly jester jewel jigsaw
jockey journal juggler juice jukebox jumper jungle kangaroo kayak kazoo kebab kelp kelpie
kettle keyboard kitchen kitten kiwi koala ladder ladle lagoon lamington lamp lantern lanyard
laptop lasso lattice laundry lava lawn legend lemon lemonade lentil letter lettuce library
lilac lily lime linen lion lizard llama lobster locket lolly lorikeet lotus lounge lunchbox
magnet magpie mallee mallet mammoth mandolin mango mantis maple marble marina market marlin
marmalade marsh mascot meadow meerkat melody melon mermaid meteor midnight minnow mint mirror
mitten monsoon moonbeam moose mosaic moss motel motorbike mountain mouse muesli muffin mural
mustard napkin nebula necklace nectar needle nest newt nickel noodle notebook nozzle nugget
numbat nutmeg oasis oatmeal oboe ocean octopus office olive onion opal orange orbit orca
orchard orchid origami osprey ostrich otter outback oyster paddle paddock padlock painter
palace pancake panda panther papaya parade parasol parcel parrot parsley pasta pasture pastry
patio pavlova peach peacock peanut pebble pecan pelican pencil pendant penguin pepper pesto
petal pewter photo pianist piano pickle picnic pigeon piglet pillow pilot pinecone pinwheel
pirate pizza planet platypus plaza plover plum pocket podcast poet pollen pond pony popcorn
poppy porch porridge possum postcard potato potter pottery prairie prawn pretzel prism pudding
puffin pulley puma pumpkin puppet puzzle quail quarry quartz quill quilt quokka quoll rabbit
radish raft rainbow raisin ranch ranger rattle raven ravioli recipe reef reindeer ribbon riddle
ridge risotto river robin robot rocket rodeo rooftop rooster rosella rowboat ruby ruler saddle
saffron sage sailboat sailor salad salmon salsa saltbush sandal sandwich sardine satchel
sausage scallop scarf scarlet scone scooter scout seagull seashell sequin shadow shamrock shell
sherbet shovel shrimp silver singer skipper skyline sled sleet slipper sloth smoothie snail
snorkel snowfall snowman soda sofa sorbet soup spaniel spanner sparkle sparrow spatula spider
spinach spindle spinifex sponge spool spoon sprocket sprout spruce squid stadium stamp stapler
starfish starlight statue steam stencil stone stopwatch stork storm strudel studio summit
sunbeam sunrise sunset sunshine surfboard sushi swag swallow swamp swan sweater swing syrup
tablet taco tadpole tailor tango teacher teacup teal teapot telescope temple tennis tent
terrace thimble thistle thunder ticket tiger timber tinsel toaster toffee tofu tomato toolbox
topaz torch toucan towel tower tractor trolley trombone trophy trowel truck truffle trumpet
tuba tugboat tulip tundra tunnel turnip turtle tuxedo tweed twilight unicorn valley vanilla
vase velvet vintage violet violin visor volcano voyage waffle wagon wallaby walnut walrus
warbler waratah wattle weasel wharf wheat whisk whistle willow windmill window winter wizard
wolf wombat workshop writer zebra zipper
acrobat admiral airship alcove alligator almanac amulet angler antelope antler archer artist
asteroid avalanche backyard badger bakery ballad banquet barge barnacle basalt bassoon bathtub
beagle bedrock beehive birch blackbird bluebell bluebird boathouse bobsled bookmark bootlace
boxcar buckwheat bulb bumblebee bunting butterfly buzzard caboose cadet calendar calico campfire
canopy cardinal carnival cascade catapult cauldron cavern chamber champion chariot charm
chipmunk chocolate chowder cinder citadel cloak cockle cogwheel colander condor cordial
cornflake cornet corridor courtyard crab cradle cranberry crescent crest crocodile crossword
crouton cruiser cuckoo cyclone dartboard daybreak daylight decoy derby dewdrop digger dinosaur
dockyard driftwood drumstick duckling dune dustpan dynamo eggshell emblem estuary evergreen
explorer fanfare farmhouse fawn fiesta figurine firefly fireside firework fishpond flagpole
flapjack flatbread fleece flint flotilla foghorn footpath forge foxglove frigate fritter
fruitcake furnace gallop gannet garnet garland gingham glade glimmer glowworm goldfish goose
gosling griffin grotto grouse gumdrop gust halo hamlet hatbox haven headland hearth hedgehog
helium herald hermit hilltop hippo holly hollow homestead honeybee hopscotch houseboat husky
icicle inlet jackal jetty juniper kestrel keystone kindling kingdom kiosk kipper lacewing
lakeside landmark lark lavender leaflet ledger lemur lifeboat limerick limpet linnet lobby
locust lodge longboat loom lullaby lupin lynx macaw mackerel magnolia mainsail manatee
mandarin manor mantle marigold marmot masthead matchbox mayfly maze milkshake millpond
minstrel monarch mongoose monocle moonlight moorland mulberry mushroom mustang nautilus nettle
nightjar nimbus nomad nutshell obelisk ocelot okapi oriole outpost overcoat oxbow pagoda
pampas panpipe pantry paperclip papyrus parakeet parsnip partridge pastel pathway pavilion
peapod pegboard pennant petunia piccolo pilgrim pinafore pineapple pinnacle pinto pipeline
pitcher plankton plume poncho poodle potluck primrose puffball pullover pumice quasar quince
quiver railway raindrop rampart rapids rattan redwood refuge regatta relic ringtail ripple
riverbank roadster rockpool rosebud rosemary rotunda rowan rubble rucksack rudder runway
rustic sailcloth sandbar sandpiper sapling sawmill scarab scrapbook seahorse seaweed sentinel
serpent shanty sheepdog shipyard shutter sidecar signpost silkworm skylark skylight slingshot
snowdrop snowflake solstice songbird spaceship sparkler speedboat spyglass squall stallion
steamboat steeple stingray stockade streamer sugarcane sunflower sundial sunhat swordfish
tabby tapestry tartan teaspoon thatch thicket thrush tidepool toadstool tomcat topsail totem
towpath trapeze treehouse trellis trinket trout twister typhoon upland vagabond viking
vineyard viola vista wagtail wanderer warren waterhole wayfarer wetland whirlwind wildcat
windsock wingspan woodland yearling
`;

// Clean, de-duplicated list (guards against typos creeping into the block above)
const WORDS = [...new Set(RAW.split(/\s+/).filter(w => /^[a-z]{4,9}$/.test(w)))];

// "Maple-Tractor", "  maple   tractor " and "MAPLE TRACTOR" all become "maple tractor"
function normalizeCode(input) {
  return String(input || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
}

// Also accept the words run together ("mapletractor")
function compactCode(input) {
  return normalizeCode(input).replace(/ /g, '');
}

// isTaken(compact) → true if that code has ever been issued
function generateCode(isTaken) {
  for (let i = 0; i < 500; i++) {
    const a = WORDS[crypto.randomInt(WORDS.length)];
    const b = WORDS[crypto.randomInt(WORDS.length)];
    if (a === b) continue;
    const code = `${a} ${b}`;
    if (!isTaken(compactCode(code))) return code;
  }
  throw new Error('Could not find an unused print code');
}

module.exports = { WORDS, normalizeCode, compactCode, generateCode };
