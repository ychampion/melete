/**
 * Three emails to try it with. The companies are invented, because a sample is
 * a sample and a made-up letter with a real company's name on it is a forgery
 * whatever it is labelled. The wording is the wording these actually arrive in:
 * a promise with no date, a price rise buried under a thank-you, a delay
 * notice that offers a voucher and never mentions the cash.
 */

export type Sample = { id: string; label: string; hint: string; text: string };

export const SAMPLES: Sample[] = [
  {
    id: 'refund',
    label: 'A refund that never came',
    hint: 'Promised in writing, five weeks ago',
    text: `From: Customer Care <care@northwind-electricals.example>
Subject: Re: Order NW-88213 — return received

Hello,

Thank you for your patience while we looked into this.

We can confirm that we received your returned item on 8 August and that it was
faulty on arrival. We have approved a full refund of £249.99 to your original
payment method.

Please allow 5 to 10 working days for the refund to appear on your statement.

We are sorry for the trouble this has caused.

Kind regards,
Priya
Northwind Electricals Customer Care`,
  },
  {
    id: 'price-rise',
    label: 'A price rise at renewal',
    hint: 'Announced in paragraph four',
    text: `From: Tunestack <hello@tunestack.example>
Subject: A few changes to your Tunestack Family plan

Hi there,

Thanks for being with us for three years. We have been busy: offline mixes,
better recommendations and lossless on every device.

To keep investing in all of that, the price of Tunestack Family is changing.
From 1 October 2026 your plan will be $22.99 a month instead of $16.99 a month.

Your next payment on 1 October 2026 will be at the new price. You do not need
to do anything. If you would rather not continue, you can cancel any time
before your renewal date and you will keep access until the end of your current
billing period.

Thanks again,
The Tunestack team`,
  },
  {
    id: 'flight',
    label: 'A flight that landed late',
    hint: 'Four hours, and a voucher instead',
    text: `From: Vantair <noreply@vantair.example>
Subject: We are sorry about VA2207 on 2 September

Dear Passenger,

We are sorry that your flight VA2207 from London Gatwick to Faro on 2 September
2026 arrived 4 hours and 20 minutes later than scheduled. The delay was caused
by a technical issue with the aircraft.

We know this disrupted your plans. As a gesture of goodwill we have added a
£40 voucher to your account, valid for 12 months on any Vantair flight.

We hope to welcome you on board again soon.

Vantair Customer Relations`,
  },
];
