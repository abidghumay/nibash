export function WhyChooseUs() {
  const pillars = [
    {
      icon: "search",
      title: "Find Your Flat With AI",
      description:
        "Describe your ideal home in Bangla, Banglish or English. Find listings that match your needs.",
    },
    {
      icon: "event_available",
      title: "24-Month Rent Increase Protection",
      description:
        "No ordinary rent increase for the first 24 months of a qualifying continuing Nibash tenancy.",
    },
    {
      icon: "account_balance_wallet",
      title: "One-Month Advance Rent Limit",
      description:
        "Standard advance rent is capped at one month; statutory Controller-approved exceptions are separate.",
    },
    {
      icon: "groups",
      title: "Tenants & Rent in One Dashboard",
      description:
        "Manage tenancy information, track rent payments, and access digital receipts and contracts.",
    },
  ];

  return (
    <section className="relative py-28 bg-[#0c0e12] overflow-hidden border-t border-white/5">
      {/* Background silver glows */}
      <div className="pointer-events-none absolute top-1/2 right-1/4 w-[600px] h-[600px] rounded-full bg-radial from-slate-400/8 via-transparent to-transparent blur-3xl" />

      <div className="max-w-[1440px] mx-auto px-5 sm:px-8 lg:px-container-padding relative z-10">
        {/* Header */}
        <div className="text-center mx-auto mb-12">
          <h2 className="text-3xl md:text-4xl xl:text-5xl font-light text-[#f8f9fa] tracking-tight leading-tight mb-4">
            A Better Rental Experience,{" "}
            <span className="font-serif italic font-normal text-silver-gradient-text">
              From Search to Settlement
            </span>
          </h2>
          <p className="text-[#a9bdd3] text-base md:text-lg leading-relaxed">
            Clearer rental terms for tenants. Less administration for owners. One connected platform.
          </p>
        </div>

        {/* 4 Pillars Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {pillars.map((item) => (
            <article
              key={item.title}
              className="group relative rounded-3xl p-7 glass-panel border border-slate-500/40 hover:border-white/30 transition-colors duration-300"
            >
              <div>
                <div className="w-14 h-14 rounded-2xl glass-panel-silver border border-white/15 flex items-center justify-center text-[#cbd5e1] mb-6 group-hover:scale-110 transition-transform duration-300 shadow-md">
                  <span aria-hidden="true" className="material-symbols-outlined text-3xl">
                    {item.icon}
                  </span>
                </div>

                <h3 className="text-xl xl:text-2xl font-semibold leading-tight text-white mb-3">
                  {item.title}
                </h3>
                <p className="text-base text-[#b8c5d6] leading-relaxed font-normal">
                  {item.description}
                </p>
              </div>

            </article>
          ))}
        </div>
        <p className="mt-7 text-center text-sm md:text-base italic leading-relaxed text-[#b8c5d6]">
          * Rent protection is a Nibash policy for qualifying tenancies; statutory exceptions may apply to advance rent.{" "}
          <a href="/policies/rental-protection" className="underline underline-offset-4 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4">Read the policy.</a>
        </p>
      </div>
    </section>
  );
}

