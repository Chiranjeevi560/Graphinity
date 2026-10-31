// Inbound signals (Bidirectional spec §3): the browser's own interest topics, by ID from the Topics
// API's published taxonomy v2 (patcg-individual-drafts/topics, taxonomy_v2.md, checked 2026-10-31),
// each under the Graphinity topic its top-level category belongs to. Categories with no Graphinity
// topic, Law & Government among them, aren't mapped.

const BY_FIELD: Readonly<Record<string, readonly number[]>> = {
  'business-startups': [
    103, 104, 113, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 419,
  ],
  'cars-vehicles': [
    57, 59, 60, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 78, 81, 82, 83, 84, 369, 370, 371, 372, 373,
    374, 375, 376, 377, 378, 379,
  ],
  'food-cooking': [172, 173, 176, 177, 450, 451, 452, 453, 454, 455, 456, 457, 458, 459, 460, 461, 462, 463, 464],
  'housing-renting': [272, 564, 565, 566, 567, 568, 569, 570, 571],
  'jobs-careers': [
    226, 227, 229, 230, 231, 233, 234, 236, 237, 238, 277, 537, 538, 539, 540, 541, 542, 543, 544, 545, 546, 547, 548,
    549, 550, 551, 552, 553, 554, 555, 556, 557, 558, 559,
  ],
  'money-tax': [
    149, 150, 151, 152, 153, 154, 157, 158, 159, 160, 161, 162, 163, 164, 170, 171, 444, 445, 446, 447, 448, 449,
  ],
  'phones-gadgets': [
    126, 128, 129, 131, 132, 134, 135, 137, 140, 141, 144, 420, 421, 422, 423, 424, 425, 426, 427, 428, 429, 430, 431,
    432, 433, 434, 435, 436, 437, 438, 439, 440, 441, 442, 443,
  ],
  shopping: [
    289, 291, 293, 294, 295, 296, 297, 298, 572, 573, 574, 575, 576, 577, 578, 579, 580, 581, 582, 583, 584, 585, 586,
    587, 588, 589, 590, 591, 592, 593, 594, 595, 596, 597, 598, 599, 600, 601, 602, 603, 604, 605, 606, 607, 608,
  ],
  travel: [332, 334, 335, 336, 337, 338, 340, 341, 343, 345, 622, 623, 624, 625, 626, 627, 628, 629],
};

const FIELD_OF = new Map(Object.entries(BY_FIELD).flatMap(([field, ids]) => ids.map(id => [id, field] as const)));

export function fieldsOfTopics(topics: readonly number[]): string[] {
  return [...new Set(topics.flatMap(t => FIELD_OF.get(t) ?? []))];
}
