const axios = require('axios');
const fs = require('fs');

const url = 'https://playtennis.usta.com/tournaments?level-category=junior';

const scrapeTournaments = async () => {
    try {
        const { data } = await axios.get(url);
        const tournaments = [];

        // Logic to scrape the required fields from the data
        // This should include parsing the HTML and extracting the fields:
        // name, location, entry_deadline, withdrawal_deadline, freeze_deadline,
        // director_name, director_phone, level, tournament_url

        // Placeholder: Example of how the scraped tournaments might look
        tournaments.push({
            name: 'Example Tournament',
            location: 'Example Location',
            entry_deadline: '2026-04-01',
            withdrawal_deadline: '2026-04-02',
            freeze_deadline: '2026-04-03',
            director_name: 'John Doe',
            director_phone: '123-456-7890',
            level: 'Level 1',
            tournament_url: 'https://example.com/tournament'
        });

        fs.writeFileSync('tournaments.json', JSON.stringify(tournaments, null, 2));
        console.log('Tournaments scraped and saved to tournaments.json');
    } catch (error) {
        console.error('Error scraping tournaments:', error);
    }
};

scrapeTournaments();