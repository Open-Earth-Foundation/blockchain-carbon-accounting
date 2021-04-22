/*
SPDX-License-Identifier: Apache-2.0
*/

"use strict";

// EmissionsRecord specific classes
const EmissionsRecord = require("./emissions.js");
const EmissionsList = require("./emissionslist.js");
const EmissionsCalc = require("./emissions-calc.js");

const MD5 = require("crypto-js/md5");

// Egrid specific classes
const { UtilityEmissionsFactorList, UtilityLookupList, UtilityLookupItem, UtilityEmissionsFactorItem } = require("./egrid-data.js");


class EmissionsRecordContract {
  constructor(stub) {
    this.stub = stub;
    // All emissions records are held in a list
    this.emissionsList = new EmissionsList(stub);
    // Egrid data is stored here (formerly dynamodb)
    this.utilityEmissionsFactorList = new UtilityEmissionsFactorList(stub);
    this.utilityLookupList = new UtilityLookupList(stub);
  }

  /**
   * Store the emissions record
   *
   * @param {ChaincodeStub} stub Chaincode Stub
   * @param {String} Id for the utility
   * @param {String} Id for the party (company) which buys power from utility
   * @param {String} from date of the time period
   * @param {String} thru date of the time period
   * @param {Double} energy usage amount
   * @param {String} UOM of energy usage amount -- ie kwh
   */
  async recordEmissions(utilityId, partyId, fromDate, thruDate, energyUseAmount, energyUseUom, url, md5) {
    // get emissions factors from eGRID database; convert energy use to emissions factor UOM; calculate energy use
    let co2Emissions = await this.getCo2Emissions(utilityId, thruDate, energyUseAmount, energyUseUom);
    let factor_source = `eGrid ${co2Emissions.year} ${co2Emissions.division_type} ${co2Emissions.division_id}`;

    // create an instance of the emissions record
    let uuid = MD5(utilityId + partyId + fromDate + thruDate).toString();
    let emissionsRecord = EmissionsRecord.createInstance(
      uuid,
      utilityId,
      partyId,
      fromDate,
      thruDate,
      co2Emissions.emissions.value, // emissions amount
      co2Emissions.renewable_energy_use_amount,
      co2Emissions.nonrenewable_energy_use_amount,
      energyUseUom,
      factor_source,
      url,
      md5,
      null // tokenId
    );

    // Add the emissions record to the list of all similar emissions records in the ledger world state
    await this.emissionsList.addEmissionsRecord(emissionsRecord, uuid);

    // Must return a serialized emissionsRecord to caller of smart contract
    return emissionsRecord;
  }

  async updateEmissionsRecord(
    uuid,
    utilityId,
    partyId,
    fromDate,
    thruDate,
    emissionsAmount,
    renewable_energy_use_amount,
    nonrenewable_energy_use_amount,
    energyUseUom,
    factor_source,
    url,
    md5,
    tokenId
  ) {
    // create an instance of the emissions record
    let emissionsRecord = EmissionsRecord.createInstance(
      uuid,
      utilityId,
      partyId,
      fromDate,
      thruDate,
      parseFloat(emissionsAmount),
      parseFloat(renewable_energy_use_amount),
      parseFloat(nonrenewable_energy_use_amount),
      energyUseUom,
      factor_source,
      url,
      md5,
      tokenId
    );

    // Update the emissions record to the list of all similar emissions records in the ledger world state
    await this.emissionsList.updateEmissionsRecord(emissionsRecord, uuid);

    // Must return a serialized emissionsRecord to caller of smart contract
    return emissionsRecord;
  }

  /**
   * Get the emissions record
   *
   * @param {String} Id for the utility
   * @param {String} Id for the party (company) which buys power from utility
   * @param {String} from date of the time period
   * @param {String} thru date of the time period
   */
  async getEmissionsData(uuid) {
    // Retrieve the current emissions record using key fields provided
    // let emissionsRecordKey = EmissionsRecord.makeKey();
    let emissionsRecord = await this.emissionsList.getEmissionsRecord(uuid);

    return emissionsRecord;
  }

  /**
   * Get all the emissions records
   * @param {String} Id for the utility
   * @param {String} Id for the party (company) which buys power from utility
   */
  async getAllEmissionsData(utilityId, partyId) {
    let queryData = {
      utilityId: utilityId,
      partyId: partyId,
    };
    let emissionsRecord = await this.emissionsList.getAllEmissionRecords(queryData);

    return emissionsRecord;
  }

  async getAllEmissionsDataByDateRange(fromDate, thruDate) {
    let queryData = {
      fromDate: fromDate,
      thruDate: thruDate,
    };
    let emissionsRecord = await this.emissionsList.getAllEmissionsDataByDateRange(queryData);

    return emissionsRecord;
  }

  async getAllEmissionsDataByDateRangeAndParty(fromDate, thruDate, partyId) {
    let queryData = {
      fromDate: fromDate,
      thruDate: thruDate,
      partyId: partyId,
    };
    let emissionsRecord = await this.emissionsList.getAllEmissionsDataByDateRangeAndParty(queryData);

    return emissionsRecord;
  }

  // replaces get_emmissions_factor in emissions-calc.js
  async getEmissionsFactor(uuid, thruDate) {
    let utilityLookup = await this.utilityLookupList.getUtilityLookupItem(uuid);

    // create newDivision object used for later query into utilityEmissionsFactorList
    let hasStateData;
    try {
      hasStateData = ((JSON.parse(utilityLookup).state_province) + "").length > 0;
    } catch (error) {
      console.error("Could not fetch state_province");
      console.error(error);
    }
    let fetchedDivisions = JSON.parse(JSON.parse(utilityLookup).divisions);
    let fetchedDivisionType = fetchedDivisions["division_type"];
    let fetchedDivisionId = fetchedDivisions["division_id"];

    let isNercRegion = fetchedDivisionType.toLowerCase() === "nerc_region";
    let isNonUSCountry = (fetchedDivisionType.toLowerCase() === "country") &&
                         (fetchedDivisionId.toLowerCase() !== "usa");
    let newDivision;
    if (hasStateData) {
      newDivision = { division_id: JSON.parse(utilityLookup).state_province, division_type: "STATE" };
    } else if (isNercRegion) {
      newDivision = fetchedDivisions;
    } else if (isNonUSCountry) {
      newDivision = { division_id: fetchedDivisionId, division_type: "Country" };
    } else {
      newDivision = { division_id: "USA", division_type: "COUNTRY" };
    }

    // check if newDivision object has ID
    if (!newDivision.division_id) {
      return reject("Utility [" + uuid + "] does not have a Division ID");
    }

    // get utility emissions factors with division_type and division_id
    let queryParams = {
      division_id: newDivision.division_id,
      division_type: newDivision.division_type
    };

    // filter matching year if found
    let year;
    try {
      year = EmissionsCalc.get_full_year_from_date(thruDate);
      if (year) { queryParams.year = year }
    } catch (error) {
      console.error("Could not fetch year");
      console.error(error);
    }

    console.log(`queryParams = ${JSON.stringify(queryParams)}`);

    // query emissions factors
    console.log("fetching utilityFactors");
    let utilityFactors = await this.utilityEmissionsFactorList.getUtilityEmissionsFactorsByDivision(queryParams);
    console.log("fetched utilityFactors. value:");

    console.log(`utilityFactors = ${utilityFactors}`);

    return utilityFactors;
  }

  // replaces get_co2_emissions in emissions-calc.js
  async getCo2Emissions(uuid, thruDate, usage, usage_uom) {
    // get emissions factor of given uuid through date
    let utilityFactorCall = await this.getEmissionsFactor(uuid, thruDate);
    let utilityFactor;
    try {
      console.log(utilityFactor);
      utilityFactor = JSON.parse(utilityFactorCall)[0].Record;
    } catch (error) {
      throw new Error("No utility emissions factor found for given query");
    }

    // initialize return variables
    let emissions_value, emissions_uom, renewable_energy_use_amount, nonrenewable_energy_use_amount;

    // calculate emissions using percent_of_renewables if found
    if (utilityFactor.percent_of_renewables) {

      emissions_uom = "g";

      let co2_equivalent_emissions_uom;
      try {
        // co2_equivalent_emissions_uom = utilityFactor.co2_equivalent_emissions_uom.toString().split("/");
        co2_equivalent_emissions_uom = (utilityFactor.co2_equivalent_emissions_uom + "").split("/");
      } catch (error) {
        console.error("Could not fetch co2_equivalent_emissions_uom");
        console.error(error);
      }

      emissions_value = 
        Number(utilityFactor.co2_equivalent_emissions) *
        usage *
        (EmissionsCalc.get_uom_factor(co2_equivalent_emissions_uom[0]) / EmissionsCalc.get_uom_factor(co2_equivalent_emissions_uom[1]));

      let percent_of_renewables = Number(utilityFactor.percent_of_renewables) / 100;

      renewable_energy_use_amount = usage * percent_of_renewables;
      nonrenewable_energy_use_amount = usage * (1 - percent_of_renewables);

    // otherwise, calculate emissions using net_generation
    } else {
      emissions_uom = "tons";

      let net_generation_uom = utilityFactor.net_generation_uom;
      let co2_equivalent_emissions_uom = utilityFactor.co2_equivalent_emissions_uom;

      let usage_uom_conversion = EmissionsCalc.get_uom_factor(usage_uom) / EmissionsCalc.get_uom_factor(net_generation_uom);
      let emissions_uom_conversion =
        EmissionsCalc.get_uom_factor(co2_equivalent_emissions_uom) / EmissionsCalc.get_uom_factor(emissions_uom);

      emissions_value =
        (Number(utilityFactor.co2_equivalent_emissions) / Number(utilityFactor.net_generation)) *
        usage *
        usage_uom_conversion *
        emissions_uom_conversion;

      let total_generation = Number(utilityFactor.non_renewables) + Number(utilityFactor.renewables);
      renewable_energy_use_amount = usage * (utilityFactor.renewables / total_generation);
      nonrenewable_energy_use_amount = usage * (utilityFactor.non_renewables / total_generation);
    }

    return {
      emissions: {
        value: emissions_value,
        uom: emissions_uom,
      },
      division_type: utilityFactor.division_type,
      division_id: utilityFactor.division_id,
      renewable_energy_use_amount: renewable_energy_use_amount,
      nonrenewable_energy_use_amount: nonrenewable_energy_use_amount,
      year: utilityFactor.year,
    };
  }

  async importUtilityFactor(
    uuid,
    year,
    country,
    division_type,
    division_id,
    division_name,
    net_generation,
    net_generation_uom,
    co2_equivalent_emissions,
    co2_equivalent_emissions_uom,
    source,
    non_renewables,
    renewables,
    percent_of_renewables
  ) {
    let utilityFactor = UtilityEmissionsFactorItem.createInstance(
      uuid,
      year,
      country,
      division_type,
      division_id,
      division_name,
      net_generation,
      net_generation_uom,
      co2_equivalent_emissions,
      co2_equivalent_emissions_uom,
      source,
      non_renewables,
      renewables,
      percent_of_renewables
    );
    await this.utilityEmissionsFactorList.addUtilityEmissionsFactor(utilityFactor, uuid);
    return utilityFactor;
  }

  async updateUtilityFactor(
    uuid,
    year,
    country,
    division_type,
    division_id,
    division_name,
    net_generation,
    net_generation_uom,
    co2_equivalent_emissions,
    co2_equivalent_emissions_uom,
    source,
    non_renewables,
    renewables,
    percent_of_renewables
  ) {
    let utilityFactor = UtilityEmissionsFactorItem.createInstance(
      uuid,
      year,
      country,
      division_type,
      division_id,
      division_name,
      net_generation,
      net_generation_uom,
      co2_equivalent_emissions,
      co2_equivalent_emissions_uom,
      source,
      non_renewables,
      renewables,
      percent_of_renewables
    );
    await this.utilityEmissionsFactorList.updateUtilityEmissionsFactor(utilityFactor, uuid);
    return utilityFactor;
  }

  async getUtilityFactor(uuid) {
    let utilityFactor = await this.utilityEmissionsFactorList.getUtilityEmissionsFactor(uuid);

    return utilityFactor;
  }

  async importUtilityIdentifier(uuid, year, utility_number, utility_name, country, state_province, divisions) {
    let utilityIdentifier = UtilityLookupItem.createInstance(
      uuid,
      year,
      utility_number,
      utility_name,
      country,
      state_province,
      divisions
    );
    await this.utilityLookupList.addUtilityLookupItem(utilityIdentifier, uuid);
    return utilityIdentifier;
  }

  async updateUtilityIdentifier(uuid, year, utility_number, utility_name, country, state_province, divisions) {
    let utilityIdentifier = UtilityLookupItem.createInstance(
      uuid,
      year,
      utility_number,
      utility_name,
      country,
      state_province,
      divisions
    );
    await this.utilityLookupList.updateUtilityLookupItem(utilityIdentifier, uuid);
    return utilityIdentifier;
  }

  async getUtilityIdentifier(uuid) {
    let utilityIdentifier = await this.utilityLookupList.getUtilityLookupItem(uuid);

    return utilityIdentifier;
  }

  async getAllUtilityIdentifiers() {
    let utilityIdentifiers = await this.utilityLookupList.getAllUtilityLookupItems();

    return utilityIdentifiers;
  }

}

module.exports = EmissionsRecordContract;
