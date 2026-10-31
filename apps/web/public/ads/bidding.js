// Protected Audience bidding logic, fetched by the browser only for someone who allowed
// partner sites. Runs on their device: a flat bid for the ad in the group, nothing leaves.
globalThis.generateBid = interestGroup => {
  const ad = interestGroup.ads && interestGroup.ads[0];
  return ad ? { bid: 1, render: ad.renderURL } : { bid: 0 };
};
